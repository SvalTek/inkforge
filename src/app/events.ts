import type { AppContext, AppView } from "./context.ts";
import { updateCursor } from "../editor/editor.ts";
import { assetFromBlob, assetMime } from "../project/assets.ts";

/** Wire every DOM event handler to the app context. */
export function bindEvents(app: AppContext): void {
  const dom = app.dom;
  dom.code.oninput = () => app.syncEditor();
  dom.code.onkeyup = () => updateCursor(app);
  dom.code.onscroll = () => {
    dom.gutter.scrollTop = dom.code.scrollTop;
  };
  document.querySelectorAll<HTMLElement>(".nav").forEach((button) => {
    button.onclick = () => app.showView((button.dataset.view as AppView) ?? "play");
  });
  dom.heroCommand.onsubmit = (e) => {
    e.preventDefault();
    app.engine?.dispatch(dom.heroInput.value);
    dom.heroInput.value = "";
  };
  dom.commandForm.onsubmit = (e) => {
    e.preventDefault();
    app.engine?.dispatch(dom.command.value);
    dom.command.value = "";
  };
  dom.restartHero.onclick = () => void app.start();
  dom.restart.onclick = () => void app.start();
  dom.run.onclick = () => {
    app.showView("play");
    void app.start();
  };
  dom.clearEvents.onclick = () => {
    if (app.runtime) {
      app.runtime.events = [];
      app.render();
    }
  };
  dom.exportBtn.onclick = () => app.exportPack();
  dom.loadBtn.onclick = () => void app.openProjectLibrary();
  dom.importBtn.onclick = () => dom.importFile.click();
  dom.importFile.onchange = async (e) => {
    try {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) await app.importPack(file);
    } catch (error) {
      alert((error as Error).message);
    }
  };
  dom.newBtn.onclick = () => void app.newProject();
  dom.addFile.onclick = () => dom.assetInput.click();
  dom.assetInput.onchange = () => {
    const files = [...(dom.assetInput.files || [])];
    for (const file of files) {
      const path = `assets/${file.name.replace(/[\\/]/g, "-")}`;
      const mime = assetMime(path);
      if (!mime) {
        dom.diagnostics.textContent = `● Unsupported asset type: ${file.name}`;
        dom.diagnostics.style.color = "#ee7c78";
        continue;
      }
      if (app.project.assets[path]) {
        dom.diagnostics.textContent = `● Asset already exists: ${path}`;
        dom.diagnostics.style.color = "#ee7c78";
        continue;
      }
      app.project.assets[path] = assetFromBlob(path, file, mime);
      void app.persist();
    }
    dom.assetInput.value = "";
    app.renderFileTree();
  };
  dom.closeProjects.onclick = () => dom.projectOverlay.classList.add("hidden");
  dom.closeInventory.onclick = () => dom.inventoryOverlay.classList.add("hidden");
}
