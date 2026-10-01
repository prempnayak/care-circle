import { useEffect, useRef } from 'react';
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

/**
 * Hosts the MCP App card (ui://care-circle/today) the way an MCP Apps host does: a sandboxed iframe,
 * an AppBridge over postMessage, then the tool input and the tool result. The card renders only from
 * the tool result's structuredContent, so it can't disagree with what was spoken.
 */
export function CardFrame({ html, toolResult, toolArgs }: { html: string; toolResult: unknown; toolArgs: Record<string, unknown> }) {
  const ref = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    let bridge: AppBridge | null = null;
    const onLoad = async () => {
      const win = iframe.contentWindow;
      if (!win) return;
      bridge = new AppBridge(null, { name: 'Care Circle simulator (Echo Show)', version: '0.1.0' }, {});
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

  return <iframe ref={ref} title="Care Circle card" className="card-frame" sandbox="allow-scripts" srcDoc={html} />;
}
