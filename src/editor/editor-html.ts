import editorCss from "./editor.css";
import editorRuntimeJs from "virtual:editor-runtime";
import type { EditorPresetBootstrap, EditorSource } from "../shared/types.js";
import { VERSION } from "../shared/version.js";

export function buildEditorHtml(source: EditorSource, presetBootstrap: EditorPresetBootstrap): string {
  const payload = serializeForInlineScript(source);
  const presets = serializeForInlineScript(presetBootstrap);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>x2k Loop Mutator</title>
<style>
${editorCss}
</style>
</head>
<body>
<div class="app">
  <!-- Header -->
  <div class="top">
    <div class="top-source"><div class="title">x2k Loop Mutator</div><div class="meta" id="sourceMeta"></div></div>
    <div class="preset-controls" aria-label="Pattern presets">
      <span class="preset-label">Preset:</span>
      <button class="button preset-arrow" id="presetPreviousButton" title="Previous preset" aria-label="Previous preset">&lt;</button>
      <select id="presetSelect" aria-label="Preset"></select>
      <button class="button preset-arrow" id="presetNextButton" title="Next preset" aria-label="Next preset">&gt;</button>
      <button class="button" id="presetSaveButton">Save</button>
      <button class="button" id="presetDeleteButton" disabled>Delete</button>
      <button class="button" id="presetImportButton">Import</button>
      <button class="button" id="presetExportButton">Export</button>
      <button class="button" id="themeToggleButton" aria-pressed="true" title="Color theme: x2k green. Click for classic grey.">Color</button>
    </div>
    <div class="row"><button class="button" id="cancelButton">Cancel</button></div>
  </div>
  <!-- Waveform panels -->
  <main class="main">
    <section class="panel"><div class="panel-head"><span>Source</span><span id="sliceCount">No slices</span></div><div class="canvas-wrap"><canvas id="sourceCanvas"></canvas><div id="sourcePlayhead" class="playhead"></div></div></section>
    <section class="panel"><div class="panel-head"><span>Mutated result</span><span id="resultMeta">Not rendered</span></div><div class="canvas-wrap"><canvas id="resultCanvas"></canvas><div id="resultEmptyState" class="empty-state">Not rendered</div><div id="resultPlayhead" class="playhead"></div></div></section>
  </main>
  <section class="right-area">
    <!-- Main controls / Slice-output controls / Filter controls -->
    <section class="top-controls">
      <div class="control-row slice-row"><div class="control-label">Slice Length</div><div class="slice-buttons"><button class="option" data-slice="half">1/2</button><button class="option active" data-slice="quarter">1/4</button><button class="option" data-slice="eighth">1/8</button></div></div>
      <div class="control-row output-row"><div class="control-label">Output Length</div><div class="output-buttons"><button class="option active" data-output-mode="source">Source</button><button class="option" data-output-bars="1">1</button><button class="option" data-output-bars="2">2</button><button class="option" data-output-bars="4">4</button><button class="option" data-output-bars="8">8</button></div></div>
      <div class="control-row filter-type-row"><div class="control-label">Filter</div><div class="filter-buttons"><button class="option active" data-filter="LP">LP</button><button class="option" data-filter="BP">BP</button><button class="option" data-filter="HP">HP</button><button class="option" data-filter="NOTCH">Notch</button></div></div>
      <div class="control-row filter-env-direction-row"><div class="control-label">Env Dir</div><div class="filter-env-direction-buttons"><button class="option active" data-filter-env-direction="UP">Up</button><button class="option" data-filter-env-direction="DOWN">Down</button></div></div>
      <div class="control-row slider-row"><div class="control-label">Cutoff</div><input id="filterCutoff" type="range" min="80" max="6000" step="10"><div class="slider-value" id="filterCutoffValue"></div></div>
<div class="control-row slider-row"><div class="control-label">Res</div><input id="filterResonance" type="range" min="0" max="1" step="0.01"><div class="slider-value" id="filterResonanceValue"></div></div>
<div class="control-row slider-row"><div class="control-label">Drive</div><input id="filterDrive" type="range" min="0" max="1" step="0.01"><div class="slider-value" id="filterDriveValue"></div></div>
<div class="control-row slider-row"><div class="control-label">Attack</div><input id="filterAttack" type="range" min="0" max="1" step="0.01"><div class="slider-value" id="filterAttackValue"></div></div>
<div class="control-row slider-row"><div class="control-label">Decay</div><input id="filterDecay" type="range" min="0" max="1" step="0.01"><div class="slider-value" id="filterDecayValue"></div></div>
    </section>
    <!-- Pattern editor -->
    <section class="pattern-control">
      <div id="patterns"></div>
    </section>
    <!-- Snapshot area -->
    <section class="snapshots">
      <div class="snapshot-panel">
        <div class="control-label">Snapshots</div>
        <div id="snapshotSlots" class="snapshot-slots"></div>
        <div class="snapshot-global-actions">
          <button id="snapshotSaveButton" class="button" title="Save selected snapshot">Save</button>
          <button id="snapshotLoadButton" class="button" title="Load selected snapshot">Load</button>
          <button id="snapshotQueueButton" class="button" title="Queue selected snapshot">Queue</button>
        </div>
      </div>
    </section>
    <!-- Footer/actions -->
    <section class="actions">
      <div class="pattern-actions"><button id="randomizeAllButton" class="button accent">Randomize All</button><button id="resetButton" class="button">Reset All</button></div>
      <div class="action-group"><button id="applyButton" class="button primary">Apply</button><button id="playResultButton" class="button">Play Result</button><button id="playSourceButton" class="button">Play Source</button><button id="stopButton" class="button">Stop</button><button id="exportCurrentButton" class="button accent" disabled>Export Current</button><button id="exportQueueButton" class="button accent" disabled>Export Queue</button></div>
    </section>
  </section>
  <footer class="footer"><div id="status" class="status">Ready</div><div class="footer-info">x2k Loop Mutator v${VERSION}</div></footer>
</div>
<div id="presetDialog" class="preset-dialog-backdrop" hidden>
  <div class="preset-dialog" role="dialog" aria-modal="true" aria-labelledby="presetDialogTitle">
    <div class="preset-dialog-title" id="presetDialogTitle">Save User Preset</div>
    <div class="preset-dialog-body">
      <label id="presetDialogLabel" for="presetNameInput">Preset name</label>
      <input id="presetNameInput" type="text" maxlength="40" autocomplete="off" spellcheck="false">
      <div id="presetDialogMessage" class="preset-dialog-message" hidden></div>
      <textarea id="presetImportJsonInput" class="preset-import-json" spellcheck="false" placeholder="Paste preset JSON here" hidden></textarea>
    </div>
    <div class="preset-dialog-actions">
      <button class="button" id="presetDialogSecondaryButton" hidden>Copy Path</button>
      <button class="button" id="presetDialogCancelButton">Cancel</button>
      <button class="button primary" id="presetDialogConfirmButton">Save</button>
    </div>
  </div>
</div>
<script>
window.__X2KLM_EDITOR_PAYLOAD__ = ${payload};
window.__X2KLM_PRESET_BOOTSTRAP__ = ${presets};
</script>
<script>
${editorRuntimeJs}
</script>
</body>
</html>`;
}

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
