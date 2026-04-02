(function () {
  const surfaces = new WeakMap();
  let monacoPromise = null;
  let themeApplied = false;

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function monacoBaseCandidates() {
    const localBase = window.location.protocol === "file:"
      ? "http://127.0.0.1:4317/vendor/monaco/vs"
      : `${window.location.origin}/vendor/monaco/vs`;
    return [
      localBase,
      "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs",
      "https://unpkg.com/monaco-editor@0.52.2/min/vs",
    ];
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-kira-monaco="${src}"]`);
      if (existing) {
        if (existing.dataset.loaded === "1") {
          resolve();
          return;
        }
        if (existing.dataset.failed === "1") {
          reject(new Error(`Failed to load ${src}`));
          return;
        }
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.dataset.kiraMonaco = src;
      script.onload = () => {
        script.dataset.loaded = "1";
        resolve();
      };
      script.onerror = () => {
        script.dataset.failed = "1";
        reject(new Error(`Failed to load ${src}`));
      };
      document.head.appendChild(script);
    });
  }

  function waitForRequire() {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const tick = () => {
        if (window.require?.config) {
          resolve(window.require);
          return;
        }
        if (Date.now() - startedAt > 4000) {
          reject(new Error("Monaco loader did not initialize."));
          return;
        }
        window.setTimeout(tick, 30);
      };
      tick();
    });
  }

  function applyTheme(monaco) {
    if (!monaco || themeApplied) {
      return;
    }
    monaco.editor.defineTheme("kirapolis-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "", foreground: "F4E8D8", background: "0A090D" },
        { token: "comment", foreground: "8F7F72" },
        { token: "keyword", foreground: "FF9A57" },
        { token: "string", foreground: "E8C07D" },
        { token: "number", foreground: "7DD3FC" },
        { token: "type.identifier", foreground: "FFCE94" },
      ],
      colors: {
        "editor.background": "#0A090D",
        "editor.foreground": "#F4E8D8",
        "editorLineNumber.foreground": "#6A5B50",
        "editorLineNumber.activeForeground": "#FFB57A",
        "editorCursor.foreground": "#FF9A57",
        "editor.selectionBackground": "#4A2511",
        "editor.inactiveSelectionBackground": "#2B1810",
        "editorIndentGuide.background1": "#241B18",
        "editorIndentGuide.activeBackground1": "#4A2B1A",
        "editorWidget.background": "#141117",
        "editorWidget.border": "#3A2A22",
        "editorGutter.background": "#0A090D",
      },
    });
    themeApplied = true;
  }

  async function ensureMonaco() {
    if (window.monaco?.editor) {
      applyTheme(window.monaco);
      return window.monaco;
    }
    if (monacoPromise) {
      return monacoPromise;
    }
    monacoPromise = (async () => {
      let lastError = null;
      for (const baseUrl of monacoBaseCandidates()) {
        try {
          if (!window.require?.config) {
            await loadScript(`${baseUrl}/loader.js`);
          }
          const requireJs = await waitForRequire();
          await new Promise((resolve, reject) => {
            requireJs.config({ paths: { vs: baseUrl } });
            requireJs(["vs/editor/editor.main"], resolve, reject);
          });
          applyTheme(window.monaco);
          return window.monaco;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error("Unable to load Monaco editor.");
    })();
    return monacoPromise;
  }

  function guessLanguage(pathValue) {
    const normalized = String(pathValue || "").toLowerCase();
    if (normalized.endsWith(".ts") || normalized.endsWith(".cts") || normalized.endsWith(".mts")) return "typescript";
    if (normalized.endsWith(".tsx")) return "typescript";
    if (normalized.endsWith(".js") || normalized.endsWith(".cjs") || normalized.endsWith(".mjs")) return "javascript";
    if (normalized.endsWith(".jsx")) return "javascript";
    if (normalized.endsWith(".json")) return "json";
    if (normalized.endsWith(".md")) return "markdown";
    if (normalized.endsWith(".html")) return "html";
    if (normalized.endsWith(".css")) return "css";
    if (normalized.endsWith(".scss")) return "scss";
    if (normalized.endsWith(".yml") || normalized.endsWith(".yaml")) return "yaml";
    if (normalized.endsWith(".xml")) return "xml";
    if (normalized.endsWith(".svg")) return "xml";
    if (normalized.endsWith(".sh")) return "shell";
    if (normalized.endsWith(".ps1")) return "powershell";
    if (normalized.endsWith(".py")) return "python";
    if (normalized.endsWith(".sql")) return "sql";
    if (normalized.endsWith(".txt")) return "plaintext";
    return "plaintext";
  }

  function buildFallback(container, options) {
    const readOnly = Boolean(options?.readOnly);
    container.innerHTML = "";
    container.classList.add("kira-editor-host");
    const fallback = document.createElement(readOnly ? "pre" : "textarea");
    fallback.className = "kira-editor-fallback";
    if (readOnly) {
      fallback.textContent = String(options?.value || "");
    } else {
      fallback.value = String(options?.value || "");
      fallback.addEventListener("input", () => {
        options?.onChange?.(fallback.value);
      });
    }
    container.appendChild(fallback);
    return {
      kind: "fallback",
      getValue: () => readOnly ? fallback.textContent || "" : fallback.value,
      setValue(nextValue) {
        if (readOnly) {
          fallback.textContent = String(nextValue || "");
          return;
        }
        fallback.value = String(nextValue || "");
      },
      setReadOnly() {},
      setLanguage() {},
      layout() {},
      focus() {
        fallback.focus();
      },
      dispose() {},
      addCommand() {},
    };
  }

  function renderMessage(container, message) {
    const existing = surfaces.get(container);
    if (existing?.dispose) {
      existing.dispose();
      surfaces.delete(container);
    }
    container.classList.add("kira-editor-host");
    container.innerHTML = `<div class="kira-editor-empty">${escapeHtml(message || "")}</div>`;
  }

  async function setContent(container, options) {
    if (!container) {
      return null;
    }
    const nextOptions = {
      value: String(options?.value || ""),
      path: String(options?.path || ""),
      readOnly: Boolean(options?.readOnly),
      onChange: typeof options?.onChange === "function" ? options.onChange : null,
      language: options?.language || guessLanguage(options?.path || ""),
    };
    try {
      const monaco = await ensureMonaco();
      let surface = surfaces.get(container);
      if (!surface || surface.kind !== "monaco") {
        const existing = surfaces.get(container);
        existing?.dispose?.();
        container.innerHTML = "";
        container.classList.add("kira-editor-host");
        const mountNode = document.createElement("div");
        mountNode.className = "kira-editor-surface";
        container.appendChild(mountNode);
        const model = monaco.editor.createModel(nextOptions.value, nextOptions.language);
        const editor = monaco.editor.create(mountNode, {
          value: nextOptions.value,
          language: nextOptions.language,
          model,
          theme: "kirapolis-dark",
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 13,
          fontLigatures: false,
          lineHeight: 20,
          scrollBeyondLastLine: false,
          wordWrap: "on",
          tabSize: 2,
          readOnly: nextOptions.readOnly,
          renderWhitespace: "selection",
          smoothScrolling: true,
          padding: { top: 12, bottom: 12 },
          scrollbar: {
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
          },
        });
        let changeDisposable = null;
        surface = {
          kind: "monaco",
          monaco,
          editor,
          model,
          setValue(nextValue) {
            if (model.getValue() !== String(nextValue || "")) {
              model.setValue(String(nextValue || ""));
            }
          },
          getValue() {
            return model.getValue();
          },
          setReadOnly(readOnly) {
            editor.updateOptions({ readOnly: Boolean(readOnly) });
          },
          setLanguage(language) {
            monaco.editor.setModelLanguage(model, language || "plaintext");
          },
          setOnChange(callback) {
            changeDisposable?.dispose?.();
            changeDisposable = callback
              ? editor.onDidChangeModelContent(() => callback(model.getValue()))
              : null;
          },
          layout() {
            editor.layout();
          },
          focus() {
            editor.focus();
          },
          addCommand(command, handler) {
            editor.addCommand(command, handler);
          },
          dispose() {
            changeDisposable?.dispose?.();
            editor.dispose();
            model.dispose();
          },
        };
        surfaces.set(container, surface);
      }
      surface.setLanguage(nextOptions.language);
      surface.setReadOnly(nextOptions.readOnly);
      surface.setOnChange(nextOptions.onChange);
      surface.setValue(nextOptions.value);
      surface.layout();
      return surface;
    } catch (_error) {
      const fallback = buildFallback(container, nextOptions);
      surfaces.set(container, fallback);
      return fallback;
    }
  }

  window.kiraWorkspaceEditor = {
    ensureMonaco,
    guessLanguage,
    renderMessage,
    setContent,
  };
})();
