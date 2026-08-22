import type { initialize } from "@ableton-extensions/sdk";

/*
 * Small self-contained notice dialogs for pre-flight validation failures.
 * These mirror the visual language of the length warning so all host-side
 * messaging stays consistent. The HTML is intentionally inline because the
 * editor bundle targets the editor itself, not these rare notices.
 */
export interface NoticeDialogArgs {
  heading: string;
  paragraphs: string[];
}

export async function showNoticeDialog(
  context: ReturnType<typeof initialize>,
  args: NoticeDialogArgs,
): Promise<void> {
  const body = args.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("");
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>x2k Loop Mutator</title>
<style>
*,*::before,*::after{box-sizing:border-box}html,body{height:100%;overflow:hidden}body{margin:0;background:#c0c0c0;color:#333333;font-family:Arial,sans-serif;font-size:12px}.wrap{height:100%;display:grid;grid-template-rows:45px minmax(0,1fr)48px;overflow:hidden}.top{background:#c0c0c0;color:#333333;padding:7px 18px;border-top:1px solid #333333;border-bottom:1px solid #333333;display:flex;align-items:center}.title{font-size:20px;font-weight:900;line-height:1}.body{min-height:0;padding:18px 22px 10px;line-height:1.45;overflow:hidden}.warning{font-size:13px;font-weight:900;margin-bottom:10px}.footer{border-top:1px solid #333333;background:#c0c0c0;padding:9px 18px;display:flex;justify-content:flex-end;align-items:center}.button{height:30px;border-radius:0px;border:1px solid #333333;background:#aaaaaa;color:#333333;font-weight:900;padding:0 18px;cursor:pointer;box-shadow:inset 0 1px 0 rgba(238,238,238,.35)}p{margin:6px 0}
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><div class="title">x2k Loop Mutator</div></div>
  <div class="body">
    <div class="warning">${escapeHtml(args.heading)}</div>
    ${body}
  </div>
  <div class="footer"><button id="closeButton" class="button">Close</button></div>
</div>
<script>
function closeDialog() { var message = { method: "close_and_send", params: ["__cancel__"] }; if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.live) { window.webkit.messageHandlers.live.postMessage(message); return; } if (window.chrome && window.chrome.webview) { window.chrome.webview.postMessage(message); return; } window.close(); }
document.getElementById("closeButton").onclick = closeDialog;
</script>
</body>
</html>`;
  await context.ui.showModalDialog(
    `data:text/html,${encodeURIComponent(html)}`,
    520,
    260,
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
