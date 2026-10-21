# Feature requests (Alexa+ add-ons)

### Proactive notifications for MCP add-ons
- **Description:** A documented way for an MCP add-on to notify a linked customer (an announcement or a notification on their devices), with explicit per-add-on consent.
- **Why it matters:** Care Circle's core value (a missed check-in reaching family) has to go out of band by email today. Family members already use Alexa; a notification there would reach them faster and more reliably.
- **Priority:** Critical

### Hackathon or sandbox access to the Alexa+ web simulator and MCP Toolkit
- **Description:** A sandbox tier of the Web Simulator and CLI for hackathon entrants.
- **Why it matters:** Without it we had to build and validate our own stand-in to prove the server follows Alexa's lifecycle and account-linking rules.
- **Priority:** Important

### Documented speaker or household context in MCP requests
- **Description:** A documented, privacy-preserving signal (for example a household-member ID, opt-in) in MCP requests.
- **Why it matters:** The token identifies the linked account, not the speaker. If a parent and caregiver share one Amazon account, an add-on can't tell them apart, so we require separate accounts.
- **Priority:** Important

### Elicitation declared in the client handshake
- **Description:** Declare `elicitation` in the client capabilities if Alexa+ supports it (the lifecycle page describes it; the sample handshake declares only `roots`).
- **Why it matters:** Confirmations (joining a circle, logging several doses) would be cleaner as structured elicitation than as a second tool call with `confirm: true`.
- **Priority:** Nice-to-have

### Time zone and locale in requests
- **Description:** Pass the device's time zone (opt-in) in request metadata.
- **Why it matters:** "Today" and "this morning" depend on it; we store a time zone per circle instead.
- **Priority:** Nice-to-have
