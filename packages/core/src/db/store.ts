import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { Db } from './client';
import {
  META,
  PROFILE,
  alertSk,
  auditSk,
  checkInSk,
  circlePk,
  codePk,
  dayPrefix,
  dosePrefix,
  dueGsi2Pk,
  dueGsi2Sk,
  medSk,
  memberSk,
  messageSk,
  newJoinCode,
  randomId,
  ttl,
  userPk,
} from './keys';
import type {
  AlertRecord,
  AlertType,
  CheckIn,
  CircleMeta,
  CircleSnapshot,
  Dose,
  DoseStatus,
  JoinCode,
  Medication,
  Member,
  MemberSummary,
  Mood,
  Role,
  StoredMessage,
  UserProfile,
} from '../types';

type Item = Record<string, unknown>;
type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>[number];

/** A transaction was cancelled; `reasons` holds each item's cancellation code (e.g. "ConditionalCheckFailed"). */
export class TransactionFailedError extends Error {
  constructor(readonly reasons: (string | undefined)[]) {
    super(`Transaction cancelled: ${reasons.join(',')}`);
  }
}

export function isConditionFailure(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException';
}

export function snapshotOf(meta: CircleMeta): CircleSnapshot {
  return {
    circleId: meta.circleId,
    recipientFirstName: meta.recipientFirstName,
    tz: meta.tz,
    window: meta.window,
    graceMin: meta.graceMin,
    paused: meta.paused,
    members: meta.members,
  };
}

function strip<T>(item: Item | undefined, omit: string[] = []): T | undefined {
  if (!item) return undefined;
  const out: Item = {};
  for (const [k, v] of Object.entries(item)) {
    if (['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'type', 'expiresAt', 'version', ...omit].includes(k)) continue;
    out[k] = v;
  }
  return out as T;
}

export interface Identity {
  profile?: UserProfile;
  membership?: Member;
}

export interface DayItems {
  checkIn?: CheckIn;
  doses: Dose[];
}

export interface DoseLogUpdate {
  dose: Dose;
  status: Extract<DoseStatus, 'taken' | 'skipped'>;
}

export interface TimelineData {
  checkIns: CheckIn[];
  doses: Dose[];
  messages: StoredMessage[];
  alerts: (AlertRecord & { circleId: string })[];
}

export interface MetaWithVersion extends CircleMeta {
  version: number;
}

export class CareStore {
  constructor(readonly db: Db) {}

  private get t() {
    return this.db.table;
  }

  // ---------------------------------------------------------------- queries

  private async queryAll(input: Omit<QueryCommandInput, 'TableName'>): Promise<Item[]> {
    const items: Item[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const out = await this.db.doc.send(new QueryCommand({ TableName: this.t, ...input, ExclusiveStartKey }));
      items.push(...((out.Items ?? []) as Item[]));
      ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  async transact(items: TransactItem[]): Promise<void> {
    try {
      await this.db.doc.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        throw new TransactionFailedError((err.CancellationReasons ?? []).map((r) => r.Code));
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------- identity

  /** GSI1: the user's profile and circle membership in one query (the first read of every authenticated tool). */
  async getIdentity(sub: string): Promise<Identity> {
    const items = await this.queryAll({
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': userPk(sub) },
    });
    const identity: Identity = {};
    for (const item of items) {
      if (item.type === 'user') identity.profile = strip<UserProfile>(item);
      else if (item.type === 'member' && !identity.membership) identity.membership = strip<Member>(item);
    }
    return identity;
  }

  async upsertProfile(sub: string, fields: { firstName?: string; email?: string }): Promise<void> {
    const sets = ['#type = :type', '#sub = :sub', 'GSI1PK = :pk', 'GSI1SK = :profile'];
    const values: Item = { ':type': 'user', ':sub': sub, ':pk': userPk(sub), ':profile': PROFILE };
    if (fields.firstName) {
      sets.push('firstName = :fn');
      values[':fn'] = fields.firstName;
    }
    if (fields.email) {
      sets.push('email = :email');
      values[':email'] = fields.email;
    }
    await this.db.doc.send(
      new UpdateCommand({
        TableName: this.t,
        Key: { PK: userPk(sub), SK: PROFILE },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: { '#type': 'type', '#sub': 'sub' },
        ExpressionAttributeValues: values,
      }),
    );
  }

  /** Count a wrong join code. Returns the count within the current one-hour window. */
  async recordFailedJoin(sub: string, now: Date, previous?: UserProfile['attempts']): Promise<number> {
    const windowFresh = previous && now.getTime() - new Date(previous.windowStart).getTime() < 60 * 60 * 1000;
    const attempts = windowFresh ? { count: previous.count + 1, windowStart: previous.windowStart } : { count: 1, windowStart: now.toISOString() };
    await this.db.doc.send(
      new UpdateCommand({
        TableName: this.t,
        Key: { PK: userPk(sub), SK: PROFILE },
        UpdateExpression: 'SET attempts = :a, #type = :type, #sub = :sub, GSI1PK = :pk, GSI1SK = :profile',
        ExpressionAttributeNames: { '#type': 'type', '#sub': 'sub' },
        ExpressionAttributeValues: { ':a': attempts, ':type': 'user', ':sub': sub, ':pk': userPk(sub), ':profile': PROFILE },
      }),
    );
    return attempts.count;
  }

  async getProfiles(subs: string[]): Promise<Map<string, UserProfile>> {
    const out = new Map<string, UserProfile>();
    const unique = [...new Set(subs)];
    for (let i = 0; i < unique.length; i += 100) {
      const chunk = unique.slice(i, i + 100);
      let request: Record<string, { Keys: Item[] }> | undefined = {
        [this.t]: { Keys: chunk.map((s) => ({ PK: userPk(s), SK: PROFILE })) },
      };
      while (request && Object.keys(request).length > 0) {
        const res = await this.db.doc.send(new BatchGetCommand({ RequestItems: request }));
        for (const item of (res.Responses?.[this.t] ?? []) as Item[]) {
          const p = strip<UserProfile>(item)!;
          out.set(p.sub, p);
        }
        request = res.UnprocessedKeys as typeof request;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- circles

  async getCircle(circleId: string): Promise<{ meta: MetaWithVersion; members: Member[] } | null> {
    const items = await this.queryAll({
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':pk': circlePk(circleId), ':from': 'MEMBER#', ':to': META },
    });
    const metaItem = items.find((i) => i.SK === META);
    if (!metaItem) return null;
    const meta = { ...strip<CircleMeta>(metaItem)!, version: (metaItem.version as number | undefined) ?? 0 };
    const members = items.filter((i) => i.type === 'member').map((i) => strip<Member>(i)!);
    return { meta, members };
  }

  async scanCircles(): Promise<CircleMeta[]> {
    const out: CircleMeta[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.db.doc.send(
        new ScanCommand({
          TableName: this.t,
          FilterExpression: 'SK = :meta AND begins_with(PK, :c)',
          ExpressionAttributeValues: { ':meta': META, ':c': 'CIRCLE#' },
          ExclusiveStartKey,
        }),
      );
      for (const item of (res.Items ?? []) as Item[]) out.push(strip<CircleMeta>(item)!);
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }

  metaPut(meta: CircleMeta, expectedVersion: number | null): TransactItem {
    return {
      Put: {
        TableName: this.t,
        Item: { PK: circlePk(meta.circleId), SK: META, type: 'circle', ...meta, version: (expectedVersion ?? -1) + 1 },
        ...(expectedVersion === null
          ? { ConditionExpression: 'attribute_not_exists(PK)' }
          : { ConditionExpression: 'version = :v', ExpressionAttributeValues: { ':v': expectedVersion } }),
      },
    };
  }

  memberPut(member: Member, mustBeNew: boolean): TransactItem {
    return {
      Put: {
        TableName: this.t,
        Item: {
          PK: circlePk(member.circleId),
          SK: memberSk(member.sub),
          GSI1PK: userPk(member.sub),
          GSI1SK: circlePk(member.circleId),
          type: 'member',
          ...member,
        },
        ...(mustBeNew ? { ConditionExpression: 'attribute_not_exists(PK)' } : {}),
      },
    };
  }

  snapshotUpdate(circleId: string, sub: string, snapshot: CircleSnapshot): TransactItem {
    return {
      Update: {
        TableName: this.t,
        Key: { PK: circlePk(circleId), SK: memberSk(sub) },
        UpdateExpression: 'SET circle = :snap',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':snap': snapshot },
      },
    };
  }

  /** Write a new META version and refresh the snapshot on every member item, atomically. */
  circleWriteItems(meta: CircleMeta, expectedVersion: number, memberSubs: string[]): TransactItem[] {
    const snap = snapshotOf(meta);
    return [this.metaPut(meta, expectedVersion), ...memberSubs.map((s) => this.snapshotUpdate(meta.circleId, s, snap))];
  }

  async createCircle(meta: CircleMeta, admin: Omit<Member, 'circle'>, now: Date): Promise<void> {
    await this.transact([
      this.metaPut(meta, null),
      this.memberPut({ ...admin, circle: snapshotOf(meta) }, true),
      this.auditPut(meta.circleId, admin.sub, 'create_circle', 'dashboard', true, now),
    ]);
  }

  async updateCircle(meta: MetaWithVersion, extra: TransactItem[] = []): Promise<void> {
    const { version, ...plain } = meta;
    await this.transact([...this.circleWriteItems(plain, version, plain.members.map((m) => m.sub)), ...extra]);
  }

  async removeMember(meta: MetaWithVersion, sub: string, actorSub: string, now: Date): Promise<void> {
    const { version, ...plain } = meta;
    const removed = plain.members.find((m) => m.sub === sub);
    const next: CircleMeta = {
      ...plain,
      members: plain.members.filter((m) => m.sub !== sub),
      recipientSub: removed?.role === 'recipient' ? undefined : plain.recipientSub,
    };
    await this.transact([
      ...this.circleWriteItems(next, version, next.members.map((m) => m.sub)),
      { Delete: { TableName: this.t, Key: { PK: circlePk(plain.circleId), SK: memberSk(sub) } } },
      this.auditPut(plain.circleId, actorSub, 'remove_member', 'dashboard', true, now),
    ]);
  }

  async updateAlertOptIn(circleId: string, sub: string, optIn: Member['alertOptIn']): Promise<void> {
    await this.db.doc.send(
      new UpdateCommand({
        TableName: this.t,
        Key: { PK: circlePk(circleId), SK: memberSk(sub) },
        UpdateExpression: 'SET alertOptIn = :o',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':o': optIn },
      }),
    );
  }

  /** Join: consume the code, add the member, and refresh everyone's snapshot in one transaction. */
  async joinCircle(args: {
    code: string;
    meta: MetaWithVersion;
    member: Omit<Member, 'circle'>;
    email?: string;
    now: Date;
  }): Promise<CircleMeta> {
    const { version, ...plain } = args.meta;
    const summary: MemberSummary = { sub: args.member.sub, firstName: args.member.firstName, role: args.member.role };
    const next: CircleMeta = {
      ...plain,
      members: [...plain.members, summary],
      ...(args.member.role === 'recipient' ? { recipientSub: args.member.sub } : {}),
    };
    const snap = snapshotOf(next);
    const profileSets = ['#type = :type', '#sub = :sub', 'GSI1PK = :pk', 'GSI1SK = :profile', 'firstName = :fn'];
    const profileValues: Item = {
      ':type': 'user',
      ':sub': args.member.sub,
      ':pk': userPk(args.member.sub),
      ':profile': PROFILE,
      ':fn': args.member.firstName,
    };
    if (args.email) {
      profileSets.push('email = :email');
      profileValues[':email'] = args.email;
    }
    await this.transact([
      { Delete: { TableName: this.t, Key: { PK: codePk(args.code), SK: META }, ConditionExpression: 'attribute_exists(PK)' } },
      this.memberPut({ ...args.member, circle: snap }, true),
      this.metaPut(next, version),
      ...plain.members.map((m) => this.snapshotUpdate(plain.circleId, m.sub, snap)),
      {
        Update: {
          TableName: this.t,
          Key: { PK: userPk(args.member.sub), SK: PROFILE },
          UpdateExpression: `SET ${profileSets.join(', ')} REMOVE attempts`,
          ExpressionAttributeNames: { '#type': 'type', '#sub': 'sub' },
          ExpressionAttributeValues: profileValues,
        },
      },
      this.auditPut(plain.circleId, args.member.sub, 'join_circle', 'join_circle', true, args.now),
    ]);
    return next;
  }

  /** Delete every item in a circle's partition (account deletion). */
  async deleteCirclePartition(circleId: string): Promise<void> {
    const items = await this.queryAll({
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': circlePk(circleId) },
      ProjectionExpression: 'PK, SK',
    });
    await this.batchDelete(items.map((i) => ({ PK: i.PK, SK: i.SK })));
  }

  async deleteProfile(sub: string): Promise<void> {
    await this.db.doc.send(new DeleteCommand({ TableName: this.t, Key: { PK: userPk(sub), SK: PROFILE } }));
  }

  /** Raw batch put, for seed scripts only. */
  async batchPut(items: Item[]): Promise<void> {
    for (let i = 0; i < items.length; i += 25) {
      let request: Record<string, { PutRequest: { Item: Item } }[]> | undefined = {
        [this.t]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })),
      };
      while (request && Object.keys(request).length > 0) {
        const res = await this.db.doc.send(new BatchWriteCommand({ RequestItems: request }));
        request = res.UnprocessedItems as typeof request;
      }
    }
  }

  private async batchDelete(keys: Item[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 25) {
      let request: Record<string, { DeleteRequest: { Key: Item } }[]> | undefined = {
        [this.t]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })),
      };
      while (request && Object.keys(request).length > 0) {
        const res = await this.db.doc.send(new BatchWriteCommand({ RequestItems: request }));
        request = res.UnprocessedItems as typeof request;
      }
    }
  }

  // ---------------------------------------------------------------- medications

  async listMedications(circleId: string): Promise<Medication[]> {
    const items = await this.queryAll({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': circlePk(circleId), ':p': 'MED#' },
    });
    return items.map((i) => strip<Medication>(i)!);
  }

  async putMedication(circleId: string, med: Medication): Promise<void> {
    await this.db.doc.send(
      new PutCommand({ TableName: this.t, Item: { PK: circlePk(circleId), SK: medSk(med.medId), type: 'med', ...med } }),
    );
  }

  async deleteMedication(circleId: string, medId: string): Promise<void> {
    await this.db.doc.send(new DeleteCommand({ TableName: this.t, Key: { PK: circlePk(circleId), SK: medSk(medId) } }));
  }

  // ---------------------------------------------------------------- join codes

  async createJoinCode(circleId: string, role: JoinCode['role'], createdBy: string, now: Date): Promise<JoinCode> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code: JoinCode = { code: newJoinCode(), circleId, role, createdBy, createdAt: now.toISOString() };
      try {
        await this.db.doc.send(
          new PutCommand({
            TableName: this.t,
            Item: { PK: codePk(code.code), SK: META, type: 'code', ...code, expiresAt: ttl.oneDay(now) },
            ConditionExpression: 'attribute_not_exists(PK)',
          }),
        );
        return code;
      } catch (err) {
        if (!isConditionFailure(err)) throw err;
      }
    }
    throw new Error('Could not allocate a join code');
  }

  /** A code, unless it is missing or past its 24-hour life (TTL deletion can lag, so check expiry here). */
  async getJoinCode(code: string, now: Date): Promise<JoinCode | null> {
    const res = await this.db.doc.send(new GetCommand({ TableName: this.t, Key: { PK: codePk(code), SK: META } }));
    const item = res.Item as Item | undefined;
    if (!item) return null;
    if (typeof item.expiresAt === 'number' && item.expiresAt * 1000 < now.getTime()) return null;
    return strip<JoinCode>(item)!;
  }

  // ---------------------------------------------------------------- day items

  async getDay(circleId: string, date: string): Promise<DayItems> {
    const items = await this.queryAll({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': circlePk(circleId), ':p': dayPrefix(date) },
    });
    return splitDay(items);
  }

  async getDoses(circleId: string, date: string): Promise<Dose[]> {
    const items = await this.queryAll({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': circlePk(circleId), ':p': dosePrefix(date) },
    });
    return items.map((i) => strip<Dose>(i)!).sort(byTime);
  }

  /** All day items from startDate to endDate inclusive (one range query). */
  async getDayRange(circleId: string, startDate: string, endDate: string): Promise<{ checkIns: CheckIn[]; doses: Dose[] }> {
    const items = await this.queryAll({
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':pk': circlePk(circleId), ':from': `DAY#${startDate}`, ':to': `DAY#${endDate}~` },
    });
    const checkIns: CheckIn[] = [];
    const doses: Dose[] = [];
    for (const item of items) {
      if (item.type === 'checkin') checkIns.push(strip<CheckIn>(item)!);
      else if (item.type === 'dose') doses.push(strip<Dose>(item)!);
    }
    return { checkIns, doses: doses.sort((a, b) => a.date.localeCompare(b.date) || byTime(a, b)) };
  }

  /** Materializer: create an open check-in item if none exists. Returns true if created. */
  async putOpenCheckIn(circleId: string, date: string, deadline: string, now: Date): Promise<boolean> {
    const sk = checkInSk(date);
    try {
      await this.db.doc.send(
        new PutCommand({
          TableName: this.t,
          Item: {
            PK: circlePk(circleId),
            SK: sk,
            type: 'checkin',
            date,
            status: 'open',
            deadline,
            GSI2PK: dueGsi2Pk(deadline.slice(0, 10)),
            GSI2SK: dueGsi2Sk(deadline, circleId, sk),
            expiresAt: ttl.thirteenMonths(now),
          },
          ConditionExpression: 'attribute_not_exists(SK)',
        }),
      );
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }

  /** Move an open check-in's deadline (window or grace changed on the dashboard). */
  async moveCheckInDeadline(circleId: string, date: string, deadline: string): Promise<void> {
    const sk = checkInSk(date);
    try {
      await this.db.doc.send(
        new UpdateCommand({
          TableName: this.t,
          Key: { PK: circlePk(circleId), SK: sk },
          UpdateExpression: 'SET deadline = :d, GSI2PK = :g2pk, GSI2SK = :g2sk',
          ConditionExpression: '#status = :open',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':d': deadline,
            ':g2pk': dueGsi2Pk(deadline.slice(0, 10)),
            ':g2sk': dueGsi2Sk(deadline, circleId, sk),
            ':open': 'open',
          },
        }),
      );
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
  }

  /** Materializer: create an open dose item if none exists. Returns true if created. */
  async putOpenDose(circleId: string, dose: Dose, sk: string, now: Date): Promise<boolean> {
    try {
      await this.db.doc.send(
        new PutCommand({
          TableName: this.t,
          Item: {
            PK: circlePk(circleId),
            SK: sk,
            type: 'dose',
            ...dose,
            GSI2PK: dueGsi2Pk(dose.deadline.slice(0, 10)),
            GSI2SK: dueGsi2Sk(dose.deadline, circleId, sk),
            expiresAt: ttl.thirteenMonths(now),
          },
          ConditionExpression: 'attribute_not_exists(SK)',
        }),
      );
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }

  /** Remove a still-open future dose that no longer matches the medication list. */
  async deleteOpenDose(circleId: string, sk: string): Promise<void> {
    try {
      await this.db.doc.send(
        new DeleteCommand({
          TableName: this.t,
          Key: { PK: circlePk(circleId), SK: sk },
          ConditionExpression: '#status = :open',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':open': 'open' },
        }),
      );
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
  }

  /**
   * Record today's check-in: keeps the first `at`, updates lastAt/mood/note, resolves the deadline.
   * Returns the item as it was before (to see whether a missed-check-in alert already went out).
   */
  async recordCheckIn(args: {
    circleId: string;
    date: string;
    now: Date;
    mood?: Mood;
    noteCipher?: string;
    crisis: boolean;
  }): Promise<{ previous?: CheckIn; at: string }> {
    const nowIso = args.now.toISOString();
    const sets = [
      '#at = if_not_exists(#at, :now)',
      'lastAt = :now',
      '#status = :done',
      '#date = :date',
      '#type = :type',
      'deadline = if_not_exists(deadline, :now)',
      'expiresAt = if_not_exists(expiresAt, :exp)',
    ];
    const values: Item = {
      ':now': nowIso,
      ':done': 'done',
      ':date': args.date,
      ':type': 'checkin',
      ':exp': ttl.thirteenMonths(args.now),
    };
    if (args.mood) {
      sets.push('mood = :mood');
      values[':mood'] = args.mood;
    }
    if (args.noteCipher) {
      sets.push('noteCipher = :note');
      values[':note'] = args.noteCipher;
    }
    if (args.crisis) {
      sets.push('crisis = :crisis');
      values[':crisis'] = true;
    }
    const res = await this.db.doc.send(
      new UpdateCommand({
        TableName: this.t,
        Key: { PK: circlePk(args.circleId), SK: checkInSk(args.date) },
        UpdateExpression: `SET ${sets.join(', ')} REMOVE GSI2PK, GSI2SK`,
        ExpressionAttributeNames: { '#at': 'at', '#status': 'status', '#date': 'date', '#type': 'type' },
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_OLD',
      }),
    );
    const previous = strip<CheckIn>(res.Attributes as Item | undefined);
    return { previous, at: previous?.at ?? nowIso };
  }

  /** Transaction item that logs one dose, conditional on the status we read (so `late` is accurate). */
  doseLogUpdate(circleId: string, u: DoseLogUpdate, byName: string, now: Date): TransactItem {
    const sk = `DAY#${u.dose.date}#DOSE#${u.dose.time}#${u.dose.medId}`;
    return {
      Update: {
        TableName: this.t,
        Key: { PK: circlePk(circleId), SK: sk },
        UpdateExpression: 'SET #status = :s, loggedAt = :at, loggedBy = :by, late = :late REMOVE GSI2PK, GSI2SK',
        ConditionExpression: '#status = :old',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':s': u.status,
          ':at': now.toISOString(),
          ':by': byName,
          ':late': u.dose.status === 'missed',
          ':old': u.dose.status,
        },
      },
    };
  }

  // ---------------------------------------------------------------- sweep

  /** Open items whose deadline (UTC date `utcDate`) is before `nowIso`. */
  async dueItems(utcDate: string, nowIso: string): Promise<Item[]> {
    return this.queryAll({
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK < :now',
      ExpressionAttributeValues: { ':pk': dueGsi2Pk(utcDate), ':now': nowIso },
    });
  }

  /** open → missed. Only the caller whose condition wins gets true, so overlapping sweeps can't double-alert. */
  async markMissed(pk: string, sk: string): Promise<boolean> {
    try {
      await this.db.doc.send(
        new UpdateCommand({
          TableName: this.t,
          Key: { PK: pk, SK: sk },
          UpdateExpression: 'SET #status = :missed REMOVE GSI2PK, GSI2SK',
          ConditionExpression: '#status = :open',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':missed': 'missed', ':open': 'open' },
        }),
      );
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }

  /** Mark that a missed alert is going out, only if the item is still missed (a late log cancels it). */
  async markAlertSent(circleId: string, sk: string): Promise<boolean> {
    try {
      await this.db.doc.send(
        new UpdateCommand({
          TableName: this.t,
          Key: { PK: circlePk(circleId), SK: sk },
          UpdateExpression: 'SET alertSent = :t',
          ConditionExpression: '#status = :missed',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':t': true, ':missed': 'missed' },
        }),
      );
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }

  // ---------------------------------------------------------------- messages

  messagePut(msg: Omit<StoredMessage, 'sk'>, now: Date): { item: TransactItem; sk: string } {
    const sk = messageSk(msg.at, randomId(4));
    return {
      sk,
      item: {
        Put: {
          TableName: this.t,
          Item: { PK: circlePk(msg.circleId), SK: sk, type: 'message', ...msg, sk, expiresAt: ttl.ninetyDays(now) },
        },
      },
    };
  }

  async getMessage(circleId: string, sk: string): Promise<StoredMessage | null> {
    const res = await this.db.doc.send(new GetCommand({ TableName: this.t, Key: { PK: circlePk(circleId), SK: sk } }));
    return strip<StoredMessage>(res.Item as Item | undefined) ?? null;
  }

  async getCheckIn(circleId: string, date: string): Promise<CheckIn | null> {
    const res = await this.db.doc.send(new GetCommand({ TableName: this.t, Key: { PK: circlePk(circleId), SK: checkInSk(date) } }));
    return strip<CheckIn>(res.Item as Item | undefined) ?? null;
  }

  // ---------------------------------------------------------------- alerts

  /** Claim an alert so it's sent once. Returns false if it was already sent (or is being sent). */
  async claimAlert(circleId: string, type: AlertType, itemKey: string, recipients: string[], now: Date): Promise<boolean> {
    try {
      await this.db.doc.send(
        new PutCommand({
          TableName: this.t,
          Item: {
            PK: circlePk(circleId),
            SK: alertSk(type, itemKey),
            type: 'alert',
            alertType: type,
            itemKey,
            recipients,
            channel: 'email',
            status: 'sending',
            claimedAt: now.toISOString(),
            expiresAt: ttl.thirteenMonths(now),
          },
          ConditionExpression: 'attribute_not_exists(SK) OR #status = :failed',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':failed': 'failed' },
        }),
      );
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }

  async finishAlert(circleId: string, type: AlertType, itemKey: string, status: AlertRecord['status'], now: Date): Promise<void> {
    await this.db.doc.send(
      new UpdateCommand({
        TableName: this.t,
        Key: { PK: circlePk(circleId), SK: alertSk(type, itemKey) },
        UpdateExpression: 'SET #status = :s, sentAt = :at',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':s': status, ':at': now.toISOString() },
      }),
    );
  }

  // ---------------------------------------------------------------- audit

  auditPut(circleId: string, actorSub: string, action: string, tool: string, ok: boolean, now: Date): TransactItem {
    return {
      Put: {
        TableName: this.t,
        Item: {
          PK: circlePk(circleId),
          SK: auditSk(now.toISOString(), randomId(6)),
          type: 'audit',
          actorSub,
          action,
          tool,
          ok,
          at: now.toISOString(),
          expiresAt: ttl.thirteenMonths(now),
        },
      },
    };
  }

  async writeAudit(circleId: string, actorSub: string, action: string, tool: string, ok: boolean, now: Date): Promise<void> {
    const put = this.auditPut(circleId, actorSub, action, tool, ok, now).Put!;
    await this.db.doc.send(new PutCommand({ TableName: put.TableName, Item: put.Item }));
  }

  // ---------------------------------------------------------------- dashboard timeline

  async getTimeline(circleId: string, startDate: string, endDate: string, sinceIso: string): Promise<TimelineData> {
    const [range, msgItems, alertItems] = await Promise.all([
      this.getDayRange(circleId, startDate, endDate),
      this.queryAll({
        KeyConditionExpression: 'PK = :pk AND SK >= :from',
        ExpressionAttributeValues: { ':pk': circlePk(circleId), ':from': `MSG#${sinceIso}` },
      }),
      this.queryAll({
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
        ExpressionAttributeValues: { ':pk': circlePk(circleId), ':p': 'ALERT#' },
      }),
    ]);
    const messages = msgItems.filter((i) => i.type === 'message').map((i) => strip<StoredMessage>(i)!);
    const alerts = alertItems
      .filter((i) => typeof i.claimedAt === 'string' && (i.claimedAt as string) >= sinceIso)
      .map((i) => ({
        circleId,
        type: i.alertType as AlertType,
        itemKey: i.itemKey as string,
        recipients: [] as string[],
        channel: 'email' as const,
        status: i.status as AlertRecord['status'],
        sentAt: i.sentAt as string | undefined,
      }));
    return { ...range, messages, alerts };
  }
}

function byTime(a: Dose, b: Dose): number {
  return a.time.localeCompare(b.time) || a.name.localeCompare(b.name);
}

function splitDay(items: Item[]): DayItems {
  const day: DayItems = { doses: [] };
  for (const item of items) {
    if (item.type === 'checkin') day.checkIn = strip<CheckIn>(item);
    else if (item.type === 'dose') day.doses.push(strip<Dose>(item)!);
  }
  day.doses.sort(byTime);
  return day;
}

export type { Role };
