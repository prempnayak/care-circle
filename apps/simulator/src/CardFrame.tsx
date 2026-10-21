import { useEffect, useRef, useState } from 'react';
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

/**
 * Hosts the MCP App card (ui://care-circle/today) the way an MCP Apps host does: a sandboxed iframe,
 * an AppBridge over postMessage, then the tool input and the tool result. The card renders only from
 * the tool result's structuredContent, so it can't disagree with what was spoken. Tool calls from the
 * card (tap-to-log) go through `oncalltool` to the host, which forwards them with the persona's token.
 */
/** The card is laid out for an Echo Show screen; draw it at that size and scale it to fit. */
const DEVICE = { w: 1024, h: 600 };

type CallToolParams = Parameters<NonNullable<AppBridge['oncalltool']>>[0];
type CallToolResult = Awaited<ReturnType<NonNullable<AppBridge['oncalltool']>>>;

export function CardFrame({
  html,
  toolResult,
  toolArgs,
  onCallTool,
}: {
  html: string;
  toolResult: unknown;
  toolArgs: Record<string, unknown>;
  /** The card asked to call a server tool (tap-to-log); the host forwards it. */
  onCallTool?: (params: CallToolParams) => Promise<CallToolResult>;
}) {
  const callRef = useRef(onCallTool);
  callRef.current = onCallTool;
  const ref = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(Math.min(el.clientWidth / DEVICE.w, el.clientHeight / DEVICE.h));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    let bridge: AppBridge | null = null;
    const onLoad = async () => {
      const win = iframe.contentWindow;
      if (!win) return;
      bridge = new AppBridge(null, { name: 'Care Circle simulator (Echo Show)', version: '0.1.0' }, { serverTools: {} });
      bridge.oncalltool = async (params) => {
        if (!callRef.current) return { isError: true, content: [{ type: 'text', text: 'Not available here.' }] };
        return callRef.current(params);
      };
      bridge.oninitialized = () => {
        void bridge!
          .sendToolInput({ arguments: toolArgs })
          .then(() => bridge!.sendToolResult(toolResult as Parameters<AppBridge['sendToolResult']>[0]));
      };
      await bridge.connect(new PostMessageTransport(win, win));
    };
    iframe.addEventListener('load', onLoad);
    return () => {
      iframe.removeEventListener('load', onLoad);
      void bridge?.close();
    };
  }, [html, toolResult, toolArgs]);

  return (
    <div className="card-box" ref={box}>
      <iframe
        ref={ref}
        title="Care Circle card"
        className="card-frame"
        sandbox="allow-scripts"
        srcDoc={html}
        style={{ width: DEVICE.w, height: DEVICE.h, transform: `scale(${scale})` }}
      />
    </div>
  );
}
