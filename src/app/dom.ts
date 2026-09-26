/**
 * Typed DOM access for the Inkforge shell.
 *
 * `queryDom` resolves every element the app touches once, keyed by purpose, so
 * the rest of the app never repeats raw selectors. `get` is the only typing aid
 * and throws on a malformed page; it is behaviour-neutral on a well-formed one.
 * `$all` is the shared multi-element query used by the render layer.
 */
export interface DomRefs {
  title: HTMLElement;
  saved: HTMLElement;
  newBtn: HTMLButtonElement;
  loadBtn: HTMLButtonElement;
  importBtn: HTMLButtonElement;
  importFile: HTMLInputElement;
  assetInput: HTMLInputElement;
  exportBtn: HTMLButtonElement;

  playView: HTMLElement;
  toolRail: HTMLElement;
  storyTitle: HTMLElement;
  heroTerminal: HTMLElement;
  uiOutput: HTMLElement;
  decision: HTMLElement;
  choiceCount: HTMLElement;
  heroChoices: HTMLElement;
  heroCommand: HTMLFormElement;
  heroInput: HTMLInputElement;
  surfaceHeader: HTMLElement;
  gameSurface: HTMLElement;
  gameHud: HTMLElement;
  restartHero: HTMLButtonElement;

  inventoryOverlay: HTMLElement;
  inventoryKicker: HTMLElement;
  inventoryTitle: HTMLElement;
  closeInventory: HTMLButtonElement;
  inventoryCount: HTMLElement;
  inventorySlots: HTMLElement;
  itemArt: HTMLElement;
  itemKicker: HTMLElement;
  itemName: HTMLElement;
  itemDescription: HTMLElement;
  itemActions: HTMLElement;
  modalHost: HTMLElement;
  /** Holds the external-link confirmation; outside `modalHost`, which repaints. */
  linkGuardHost: HTMLElement;
  projectOverlay: HTMLElement;
  projectList: HTMLElement;
  closeProjects: HTMLButtonElement;

  authorView: HTMLElement;
  tree: HTMLElement;
  tabs: HTMLElement;
  editorWrap: HTMLElement;
  assetPreview: HTMLElement;
  addFile: HTMLButtonElement;
  createNew: HTMLButtonElement;
  createOverlay: HTMLElement;
  createTitle: HTMLElement;
  createLabel: HTMLElement;
  createName: HTMLInputElement;
  createError: HTMLElement;
  createClose: HTMLButtonElement;
  createCancel: HTMLButtonElement;
  createSubmit: HTMLButtonElement;
  /** The editor's mount point; CodeMirror owns everything inside it. */
  code: HTMLElement;
  cursor: HTMLElement;
  diagnostics: HTMLElement;
  format: HTMLElement;
  runTitle: HTMLElement;
  restart: HTMLButtonElement;
  run: HTMLButtonElement;
  location: HTMLElement;
  terminal: HTMLElement;
  choices: HTMLElement;
  commandForm: HTMLFormElement;
  command: HTMLInputElement;
  clearEvents: HTMLButtonElement;
  eventLog: HTMLElement;
}

function get<T extends Element>(selector: string): T {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element as T;
}

/** Query every matching element as an array. */
export function $all<T extends Element>(selector: string): T[] {
  return [...document.querySelectorAll(selector)] as T[];
}

/** Resolve every element the app references, keyed by purpose. */
export function queryDom(): DomRefs {
  return {
    title: get("#title"),
    saved: get("#saved"),
    newBtn: get("#newBtn"),
    loadBtn: get("#loadBtn"),
    importBtn: get("#importBtn"),
    importFile: get("#importFile"),
    assetInput: get("#assetInput"),
    exportBtn: get("#exportBtn"),

    playView: get("#playView"),
    toolRail: get("#toolRail"),
    storyTitle: get("#storyTitle"),
    heroTerminal: get("#heroTerminal"),
    uiOutput: get("#uiOutput"),
    decision: get("#decision"),
    choiceCount: get("#choiceCount"),
    heroChoices: get("#heroChoices"),
    heroCommand: get("#heroCommand"),
    heroInput: get("#heroInput"),
    surfaceHeader: get("#surfaceHeader"),
    gameSurface: get("#gameSurface"),
    gameHud: get("#gameHud"),
    restartHero: get("#restartHero"),

    inventoryOverlay: get("#inventoryOverlay"),
    inventoryKicker: get("#inventoryKicker"),
    inventoryTitle: get("#inventoryTitle"),
    closeInventory: get("#closeInventory"),
    inventoryCount: get("#inventoryCount"),
    inventorySlots: get("#inventorySlots"),
    itemArt: get("#itemArt"),
    itemKicker: get("#itemKicker"),
    itemName: get("#itemName"),
    itemDescription: get("#itemDescription"),
    itemActions: get("#itemActions"),
    modalHost: get("#modalHost"),
    linkGuardHost: get("#linkGuardHost"),
    projectOverlay: get("#projectOverlay"),
    projectList: get("#projectList"),
    closeProjects: get("#closeProjects"),

    authorView: get("#authorView"),
    tree: get(".tree"),
    tabs: get(".tabs"),
    editorWrap: get(".editor-wrap"),
    assetPreview: get("#assetPreview"),
    addFile: get("#addFile"),
    createNew: get("#createNew"),
    createOverlay: get("#createOverlay"),
    createTitle: get("#createTitle"),
    createLabel: get("#createLabel"),
    createName: get("#createName"),
    createError: get("#createError"),
    createClose: get("#closeCreate"),
    createCancel: get("#createCancel"),
    createSubmit: get("#createSubmit"),
    code: get("#code"),
    cursor: get("#cursor"),
    diagnostics: get("#diagnostics"),
    format: get("#format"),
    runTitle: get("#runTitle"),
    restart: get("#restart"),
    run: get("#run"),
    location: get("#location"),
    terminal: get("#terminal"),
    choices: get("#choices"),
    commandForm: get("#commandForm"),
    command: get("#command"),
    clearEvents: get("#clearEvents"),
    eventLog: get("#eventLog"),
  };
}
