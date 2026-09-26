import type { AppContext, AppView } from "./context.ts";
import { clearTranscript } from "../engine/events.ts";
import { assetFromBlob, assetMime } from "../project/assets.ts";
import { installLinkGuard } from "../ui/link-guard.ts";

/** Wire every DOM event handler to the app context. */
export function bindEvents(app: AppContext): void {
  const dom = app.dom;
  // The editor is not bound here: `createCodeEditor` takes `onChange` and
  // `onSelection` at mount, so the buffer, the caret readout and the scroll
  // position are the editor's own concern rather than three DOM handlers.
  installLinkGuard(dom.linkGuardHost);
  document.querySelectorAll<HTMLElement>(".nav").forEach((button) => {
    button.onclick = () => app.showView((button.dataset.view as AppView) ?? "play");
  });
  dom.heroCommand.onsubmit = (e) => {
    e.preventDefault();
    void app.engine?.dispatch(dom.heroInput.value);
    dom.heroInput.value = "";
  };
  dom.commandForm.onsubmit = (e) => {
    e.preventDefault();
    void app.engine?.dispatch(dom.command.value);
    dom.command.value = "";
  };
  dom.restartHero.onclick = () => void app.start();
  dom.run.onclick = () => {
    app.showView("play");
    void app.start();
  };
  dom.clearEvents.onclick = () => {
    if (app.runtime) {
      clearTranscript(app.runtime);
      app.render();
    }
  };
  dom.exportBtn.onclick = () => app.exportPack();
  dom.loadBtn.onclick = () => void app.openProjectLibrary();
  dom.importBtn.onclick = () => dom.importFile.click();
  dom.importFile.onchange = async (e) => {
    const input = e.target as HTMLInputElement;
    try {
      const file = input.files?.[0];
      if (file) await app.importPack(file);
    } catch (error) {
      alert((error as Error).message);
    } finally {
      input.value = "";
    }
  };
  dom.newBtn.onclick = () => void app.newProject();
  dom.saveBtn.onclick = () => void app.saveGame();
  dom.savesBtn.onclick = () => void app.openSaveManager();
  dom.importSaveBtn.onclick = () => dom.saveFile.click();
  dom.saveFile.onchange = async (e) => {
    const input = e.target as HTMLInputElement;
    try {
      const file = input.files?.[0];
      if (file) await app.importSaveFile(file);
    } catch (error) {
      alert((error as Error).message);
    } finally {
      // Cleared so re-picking the same file still fires `change`; without this a
      // player who imports, dismisses the confirm, and retries gets silence.
      input.value = "";
    }
  };
  dom.addFile.onclick = () => dom.assetInput.click();
  dom.createNew.onclick = () => app.openCreateDialog("");
  dom.createClose.onclick = () => dom.createOverlay.classList.add("hidden");
  dom.createCancel.onclick = () => dom.createOverlay.classList.add("hidden");
  dom.createSubmit.onclick = () => app.submitCreate();
  dom.createName.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      app.submitCreate();
    } else if (event.key === "Escape") {
      dom.createOverlay.classList.add("hidden");
    }
  });
  for (const button of [...document.querySelectorAll<HTMLButtonElement>("#createOverlay [data-create-kind]")]) {
    button.onclick = () => app.setCreateKind((button.dataset.createKind as "folder" | "yaml" | "lua") ?? "folder");
  }
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
  dom.closeSaves.onclick = () => dom.saveOverlay.classList.add("hidden");
  dom.closeInventory.onclick = () => dom.inventoryOverlay.classList.add("hidden");
}
