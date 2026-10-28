// Browser half of @local/dsh-whisper-dictation: a Plugins → Dictation card that
// edits the live cleanup and dictionary settings. Hand-written in the factory
// form dsh's client module system loads, so the plugin needs no build step.
window.__ModuleLoader__.load({
	id: "@local/dsh-whisper-dictation",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const { jsx, jsxs } = require("react/jsx-runtime");
		const { SettingsForm } = require("@deepseek-ai/dsh-client-ui-primitives");
		const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.whisperDictation";
		/** Settings namespace: the plugin's profile entry id. */
		const ENTRY = "whisper-dictation";

		const en = {
			title: "Dictation",
			description: "Whisper dictation with AI cleanup, a custom dictionary, replacements and snippets.",
			intro: "Pick the Whisper size under Plugins → Voice input (Recognition provider). These settings shape what lands in the draft after recognition.",
			cleanup: "AI cleanup",
			cleanupHint: "After Whisper, a fast model removes filler words, fixes punctuation and self-corrections, and applies your dictionary. Failures fall back to the raw transcript.",
			model: "Cleanup model",
			dictionary: "Dictionary",
			dictionaryHint: "One term per line, spelled exactly as it should appear (names, products, jargon). Cleanup is told to use these spellings, and differently-cased matches are corrected.",
			replacements: "Replacements",
			replacementsHint: "One rule per line: heard => written. Alternatives with |, e.g. “deep seek | deepseek => DeepSeek”. Applied before and after cleanup, on whole words.",
			snippets: "Snippets",
			snippetsHint: "One per line: trigger => text. Saying the trigger inserts the text; use \\n for a line break.",
			instructions: "Extra instructions",
			instructionsHint: "Appended to the cleanup prompt, e.g. context about what you dictate.",
			useCodingContext: "Insert coding-agent context",
			agentName: "Agent name",
			agentNameHint: "Name the cleanup prompt treats as dictated text, not a command.",
			spelling: "English spelling",
			prompt: "Cleanup prompt",
			promptHint: "Leave empty to use OpenWhispr's cleanup prompt. {{agentName}} is substituted; language, extra instructions and the dictionary are appended.",
			showDefault: "Start from the OpenWhispr prompt",
			loading: "Loading models…",
			unavailable: "currently unavailable",
			badLines: "Ignored lines without “=>”: {lines}",
			conflict: "Settings changed elsewhere. Discard your draft and try again.",
			unavailablePlugin: "This plugin is not loaded, so it cannot be configured right now.",
			readOnly: "This deployment stores settings read-only.",
			saveFailed: "The deployment did not accept these settings; they were left for you to correct.",
			save: "Save",
			saving: "Saving…"
		};
		const zh = {
			...en,
			title: "听写",
			description: "Whisper 听写，附带 AI 清理、自定义词典、替换规则和片段。",
			save: "保存",
			saving: "保存中…"
		};

		const CODING_CONTEXT = "CONTEXT: The dictation is a message the speaker is writing to an AI coding agent in a developer tool. Prefer the technical reading of ambiguous words (e.g. \"get hub\" → GitHub, \"pie test\" → pytest, \"jason\" → JSON when it means the format). Write code identifiers, file names, paths, CLI commands, flags and package names in their conventional form. Do not add content.";

		const FIELDS = ["cleanup", "cleanupProvider", "cleanupModel", "cleanupPrompt", "instructions", "agentName", "spelling", "dictionary", "replacements", "snippets"];

		function routeKey(provider, model) {
			return `${provider}\0${model}`;
		}

		/** Config value -> editable text form. */
		function toForm(value) {
			const v = value ?? {};
			return {
				cleanup: v.cleanup ?? true,
				route: routeKey(v.cleanupProvider ?? "", v.cleanupModel ?? ""),
				cleanupPrompt: v.cleanupPrompt ?? "",
				instructions: v.instructions ?? "",
				agentName: v.agentName ?? "",
				spelling: v.spelling ?? "en-US",
				dictionary: (v.dictionary ?? []).join("\n"),
				replacements: (v.replacements ?? []).map((rule) => `${rule.from} => ${rule.to}`).join("\n"),
				snippets: (v.snippets ?? []).map((snippet) => `${snippet.trigger} => ${snippet.replacement.replace(/\n/g, "\\n")}`).join("\n")
			};
		}

		function parsePairs(text) {
			const pairs = [], bad = [];
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				const at = line.indexOf("=>");
				if (at < 0) { bad.push(line.trim()); continue; }
				const left = line.slice(0, at).trim(), right = line.slice(at + 2).trim();
				if (!left) { bad.push(line.trim()); continue; }
				pairs.push([left, right]);
			}
			return { pairs, bad };
		}

		/** Editable text form -> config values. */
		function fromForm(form) {
			const [cleanupProvider, cleanupModel] = form.route.split("\0");
			const seen = new Set();
			const dictionary = [];
			for (const line of form.dictionary.split("\n")) {
				const term = line.trim();
				if (term && !seen.has(term.toLowerCase())) { seen.add(term.toLowerCase()); dictionary.push(term); }
			}
			return {
				cleanup: form.cleanup,
				cleanupProvider: cleanupProvider ?? "",
				cleanupModel: cleanupModel ?? "",
				cleanupPrompt: form.cleanupPrompt,
				instructions: form.instructions,
				agentName: form.agentName.trim(),
				spelling: form.spelling,
				dictionary,
				replacements: parsePairs(form.replacements).pairs.map(([from, to]) => ({ from, to })),
				snippets: parsePairs(form.snippets).pairs.map(([trigger, replacement]) => ({ trigger, replacement: replacement.replace(/\\n/g, "\n") }))
			};
		}

		function sameValues(a, b) {
			return JSON.stringify(FIELDS.map((key) => a[key])) === JSON.stringify(FIELDS.map((key) => b[key]));
		}

		class DictationCardController {
			catalogGroups = [];
			catalogStatus = "idle";
			draft;
			draftRevision;
			saving = false;
			failed = false;
			conflicted = false;
			disposed = false;
			saveGeneration = 0;
			catalogGeneration = 0;

			constructor(scope, ctx) {
				this.scope = scope;
				this.ctx = ctx;
				this.store = createSnapshotStore(this.projection());
				this.unsubscribe = scope.subscribe(() => {
					if (!this.saving && this.draft !== undefined && scope.getSnapshot().revision !== this.draftRevision) {
						if (sameValues(fromForm(this.draft), fromForm(toForm(scope.getSnapshot().value)))) this.clearDraft();
						else this.conflicted = true;
					}
					if (this.catalogStatus === "idle") this.loadCatalog();
					this.publish();
				});
				this.loadCatalog();
			}

			inject() {
				return {
					hooks: { dictationCard: this.store },
					edit: (patch) => this.edit(patch),
					save: () => this.save(),
					discard: () => this.discard()
				};
			}

			current() {
				return toForm(this.scope.getSnapshot().value);
			}

			form() {
				return this.draft ?? this.current();
			}

			edit(patch) {
				const snapshot = this.scope.getSnapshot();
				if (this.disposed || snapshot.status !== "ready" || !snapshot.writable || this.saving) return;
				if (this.draft === undefined) this.draftRevision = snapshot.revision;
				this.draft = { ...this.form(), ...patch };
				this.failed = false;
				this.publish();
			}

			clearDraft() {
				this.draft = undefined;
				this.draftRevision = undefined;
				this.failed = false;
				this.conflicted = false;
			}

			discard() {
				if (this.saving) return;
				this.clearDraft();
				this.publish();
			}

			async save() {
				const snapshot = this.scope.getSnapshot();
				if (this.disposed || snapshot.status !== "ready" || !snapshot.writable || this.saving || this.draft === undefined) return;
				const desired = fromForm(this.draft);
				const current = fromForm(this.current());
				if (sameValues(desired, current)) return this.discard();
				if (snapshot.revision !== this.draftRevision) {
					this.conflicted = true;
					return this.publish();
				}
				const generation = this.saveGeneration;
				this.saving = true;
				this.failed = false;
				this.publish();
				const ops = FIELDS.filter((key) => JSON.stringify(desired[key]) !== JSON.stringify(current[key])).map((key) => ({ op: "set", path: [key], value: desired[key] }));
				await this.scope.mutate(ops, this.draftRevision);
				if (generation !== this.saveGeneration) return;
				const landed = sameValues(fromForm(this.current()), desired);
				this.saving = false;
				this.failed = !landed;
				if (landed) this.clearDraft();
				this.publish();
			}

			refreshCatalog() {
				if (this.disposed) return;
				this.catalogGeneration += 1;
				this.catalogStatus = "idle";
				this.loadCatalog();
			}

			resetConnection() {
				if (this.disposed) return;
				this.saveGeneration += 1;
				this.saving = false;
				this.clearDraft();
				this.catalogGroups = [];
				this.refreshCatalog();
			}

			async loadCatalog() {
				if (this.disposed || this.catalogStatus === "loading") return;
				const generation = this.catalogGeneration;
				this.catalogStatus = "loading";
				this.publish();
				const response = await this.ctx.remote.session.modelCatalog();
				if (generation !== this.catalogGeneration || this.disposed) return;
				if (response.ok) {
					this.catalogGroups = response.value.groups;
					this.catalogStatus = "ready";
				} else this.catalogStatus = "error";
				this.publish();
			}

			projection() {
				const snapshot = this.scope.getSnapshot();
				const form = this.form();
				const dirty = this.draft !== undefined && !sameValues(fromForm(this.draft), fromForm(this.current()));
				const listed = new Set(this.catalogGroups.flatMap((group) => group.models.map((model) => routeKey(group.id, model.id))));
				const missing = [...new Set([this.current().route, form.route])].filter((key) => key !== routeKey("", "") && !listed.has(key));
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable,
					dirty,
					invalid: this.conflicted,
					saving: this.saving,
					failed: this.failed,
					conflicted: this.conflicted,
					form,
					groups: this.catalogGroups,
					missing,
					catalogStatus: this.catalogStatus,
					badLines: [...parsePairs(form.replacements).bad, ...parsePairs(form.snippets).bad]
				};
			}

			publish() {
				this.store.set(this.projection());
			}

			dispose() {
				this.disposed = true;
				this.saveGeneration += 1;
				this.catalogGeneration += 1;
				this.unsubscribe();
			}
		}

		const noteStyle = { margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary)" };
		const errorStyle = { ...noteStyle, color: "var(--dsw-alias-state-error-primary)" };
		const inputStyle = {
			width: "100%",
			maxWidth: 560,
			padding: "6px 8px",
			font: "inherit",
			color: "inherit",
			background: "transparent",
			border: "1px solid var(--dsw-alias-border-primary, currentColor)",
			borderRadius: 6,
			boxSizing: "border-box"
		};
		const areaStyle = { ...inputStyle, fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)", fontSize: 12, resize: "vertical" };
		const linkStyle = { color: "var(--dsw-alias-brand-primary)", background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit", fontSize: 12, alignSelf: "flex-start" };
		const fieldStyle = { display: "flex", flexDirection: "column", gap: 6 };

		function Field({ id, label, hint, children }) {
			return jsxs("div", { style: fieldStyle, children: [
				jsx("label", { htmlFor: id, style: { fontWeight: 500 }, children: label }),
				children,
				hint ? jsx("p", { style: noteStyle, children: hint }) : null
			] });
		}

		function DictationCard(props) {
			const { t } = props;
			const state = props.useDictationCard((snapshot) => snapshot);
			if (props.view === "summary") return t("description");
			const form = state.form;
			const disabled = !state.writable || state.saving;
			const edit = props.edit;
			const area = (key, rows, placeholder) => jsx("textarea", {
				id: `plugin-config-dictation-${key}`,
				style: areaStyle,
				rows,
				spellCheck: false,
				placeholder,
				value: form[key],
				disabled,
				onChange: (event) => edit({ [key]: event.target.value })
			});
			const options = [];
			for (const group of state.groups) {
				if (group.models.length === 0) continue;
				options.push(jsx("optgroup", { label: group.name, children: group.models.map((model) => jsx("option", { value: routeKey(group.id, model.id), children: model.name }, model.id)) }, group.id));
			}
			for (const key of state.missing) {
				const [provider, model] = key.split("\0");
				options.push(jsx("option", { value: key, children: `${provider}/${model} (${t("unavailable")})` }, key));
			}
			return jsx(SettingsForm, {
				labels: { unavailable: t("unavailablePlugin"), readOnly: t("readOnly"), saveFailed: t("saveFailed"), save: t("save"), saving: t("saving") },
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children: jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 18 }, children: [
					jsx("p", { style: noteStyle, children: t("intro") }),
					jsxs("div", { style: fieldStyle, children: [
						jsxs("label", { style: { display: "flex", gap: 8, alignItems: "center", fontWeight: 500 }, children: [
							jsx("input", { type: "checkbox", checked: form.cleanup, disabled, onChange: (event) => edit({ cleanup: event.target.checked }) }),
							t("cleanup")
						] }),
						jsx("p", { style: noteStyle, children: t("cleanupHint") })
					] }),
					jsx(Field, { id: "plugin-config-dictation-model", label: t("model"), children: jsxs("select", {
						id: "plugin-config-dictation-model",
						style: inputStyle,
						value: form.route,
						disabled: disabled || !form.cleanup,
						onChange: (event) => edit({ route: event.target.value }),
						children: options
					}) }),
					state.catalogStatus === "loading" ? jsx("p", { style: noteStyle, role: "status", children: t("loading") }) : null,
					jsx(Field, { id: "plugin-config-dictation-dictionary", label: t("dictionary"), hint: t("dictionaryHint"), children: area("dictionary", 6, "DeepSeek\nGitHub\nKubernetes\npytest") }),
					jsx(Field, { id: "plugin-config-dictation-replacements", label: t("replacements"), hint: t("replacementsHint"), children: area("replacements", 4, "deep seek | deepseek => DeepSeek\nclaude code => Claude Code") }),
					jsx(Field, { id: "plugin-config-dictation-snippets", label: t("snippets"), hint: t("snippetsHint"), children: area("snippets", 3, "my email => me@example.com") }),
					state.badLines.length ? jsx("p", { style: errorStyle, role: "status", children: t("badLines", { lines: state.badLines.join(" · ") }) }) : null,
					jsx(Field, { id: "plugin-config-dictation-instructions", label: t("instructions"), hint: t("instructionsHint"), children: jsxs("div", { style: fieldStyle, children: [
						area("instructions", 3, ""),
						form.instructions.includes(CODING_CONTEXT) ? null : jsx("button", { type: "button", style: linkStyle, disabled, onClick: () => edit({ instructions: form.instructions.trim() ? `${form.instructions.trim()}\n\n${CODING_CONTEXT}` : CODING_CONTEXT }), children: t("useCodingContext") })
					] }) }),
					jsxs("div", { style: { display: "flex", gap: 16, flexWrap: "wrap" }, children: [
						jsx(Field, { id: "plugin-config-dictation-agent", label: t("agentName"), hint: t("agentNameHint"), children: jsx("input", { id: "plugin-config-dictation-agent", style: { ...inputStyle, maxWidth: 240 }, value: form.agentName, disabled, placeholder: "Assistant", onChange: (event) => edit({ agentName: event.target.value }) }) }),
						jsx(Field, { id: "plugin-config-dictation-spelling", label: t("spelling"), children: jsxs("select", { id: "plugin-config-dictation-spelling", style: { ...inputStyle, maxWidth: 200 }, value: form.spelling, disabled, onChange: (event) => edit({ spelling: event.target.value }), children: [
							jsx("option", { value: "en-US", children: "American (en-US)" }),
							jsx("option", { value: "en-GB", children: "British (en-GB)" })
						] }) })
					] }),
					jsx(Field, { id: "plugin-config-dictation-cleanupPrompt", label: t("prompt"), hint: t("promptHint"), children: area("cleanupPrompt", form.cleanupPrompt ? 12 : 2, "OpenWhispr default") })
				] })
			});
		}

		const inject = ["slots", "locale", "remote", "remote.session", "configForms"];

		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "whisper-dictation: dictionaries");
			const card = new DictationCardController(ctx.configForms.get(ENTRY), ctx);
			const face = card.inject();
			ctx.effect(() => ctx.remote.$on("llm/adapters-updated", () => card.refreshCatalog()), "whisper-dictation: adapter invalidations");
			ctx.effect(() => ctx.on("connection/reset", () => card.resetConnection()), "whisper-dictation: connection generation");
			ctx.effect(() => () => card.dispose(), "whisper-dictation: form subscription");
			ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => ctx.slots.inject("plugins.item", () => ctx.slots.register({
				name: "plugins.item",
				id: "whisper-dictation",
				order: 110,
				label: () => t("title"),
				locale: NS,
				inject: () => face
			}, DictationCard))), "whisper-dictation: page");
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
