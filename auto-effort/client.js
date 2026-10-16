// Browser half of @local/dsh-auto-effort: a Settings → Plugins card that picks
// the evaluator model. Hand-written in the factory form dsh's client module
// system loads (the shape tsdown emits for the shipped settings pages), so the
// plugin needs no build step.
window.__ModuleLoader__.load({
	id: "@local/dsh-auto-effort",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const { jsx, jsxs } = require("react/jsx-runtime");
		const { SettingsForm } = require("@deepseek-ai/dsh-client-ui-primitives");
		const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.autoEffort";
		/** Settings namespace: the plugin's profile entry id. */
		const AUTO_EFFORT_NS = "auto-effort";

		const en = {
			title: "Auto effort",
			description: "Choose the model that picks a reasoning level for each prompt.",
			evaluator: "Evaluator model",
			evaluatorHint: "Scores each prompt while Effort is on Default and picks one of the current model's levels. Pick a fast text model; it runs before every human turn. Changes apply to the next turn.",
			loading: "Loading models…",
			loadFailed: "Models could not be loaded.",
			retry: "Retry",
			partial: "Some model providers could not be loaded.",
			unavailable: "currently unavailable",
			conflict: "Settings changed elsewhere. Discard your draft and try again.",
			unavailablePlugin: "This plugin is not loaded, so it cannot be configured right now.",
			readOnly: "This deployment stores settings read-only.",
			saveFailed: "The deployment did not accept this model; it was left for you to correct.",
			save: "Save",
			saving: "Saving…"
		};
		const zh = {
			title: "自动推理强度",
			description: "选择为每条提示挑选推理强度的模型。",
			evaluator: "评估模型",
			evaluatorHint: "当推理强度为“默认”时，为每条提示打分，并从当前模型支持的强度中选择一个。请选择快速的文本模型；它会在每轮人工输入前运行。修改从下一轮开始生效。",
			loading: "正在加载模型…",
			loadFailed: "无法加载模型。",
			retry: "重试",
			partial: "部分模型提供方暂时无法加载。",
			unavailable: "当前不可用",
			conflict: "设置已在其他位置更新。请放弃修改后重试。",
			unavailablePlugin: "该插件当前未加载，暂时无法配置。",
			readOnly: "本部署的设置为只读。",
			saveFailed: "本部署没有接受该模型，已保留供你修改。",
			save: "保存",
			saving: "保存中…"
		};

		/** Opaque lookup key for one provider/model route; never parsed. */
		function routeKey(route) {
			return `${route.provider}\0${route.model}`;
		}

		/** Staged evaluator-route editor over the `auto-effort` settings namespace and the Host model catalog. */
		class AutoEffortCardController {
			catalogGroups = [];
			catalogPartial = false;
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
						if (routeKey(this.current()) === routeKey(this.draft)) this.clearDraft();
						else this.conflicted = true;
					}
					if (this.catalogStatus === "idle") this.loadCatalog();
					this.publish();
				});
				this.loadCatalog();
			}

			inject() {
				return {
					hooks: { autoEffortCard: this.store },
					select: (key) => this.select(key),
					retryCatalog: () => this.loadCatalog(),
					save: () => this.save(),
					discard: () => this.discard()
				};
			}

			current() {
				const value = this.scope.getSnapshot().value;
				return { provider: value?.provider ?? "", model: value?.model ?? "" };
			}

			desired() {
				return this.draft ?? this.current();
			}

			options() {
				const current = this.current();
				const desired = this.desired();
				const groups = this.catalogGroups.map((group) => ({
					id: group.id,
					name: group.name,
					models: group.models.map((model) => ({ key: routeKey({ provider: group.id, model: model.id }), provider: group.id, model: model.id, name: model.name }))
				}));
				const listed = new Set(groups.flatMap((group) => group.models.map((model) => model.key)));
				const missing = [];
				for (const route of [current, desired]) {
					const key = routeKey(route);
					if (route.provider && route.model && !listed.has(key)) {
						listed.add(key);
						missing.push({ key, ...route, name: route.model });
					}
				}
				return { groups, missing };
			}

			select(key) {
				const snapshot = this.scope.getSnapshot();
				if (this.disposed || snapshot.status !== "ready" || !snapshot.writable || this.saving) return;
				const { groups, missing } = this.options();
				const route = [...groups.flatMap((group) => group.models), ...missing].find((option) => option.key === key);
				if (route === undefined) return;
				if (this.draft === undefined) this.draftRevision = snapshot.revision;
				this.draft = { provider: route.provider, model: route.model };
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
				const desired = this.desired();
				if (this.disposed || snapshot.status !== "ready" || !snapshot.writable || this.saving || this.draft === undefined) return;
				if (routeKey(desired) === routeKey(this.current())) {
					this.discard();
					return;
				}
				if (snapshot.revision !== this.draftRevision) {
					this.conflicted = true;
					this.publish();
					return;
				}
				const generation = this.saveGeneration;
				this.saving = true;
				this.failed = false;
				this.publish();
				await this.scope.mutate([
					{ op: "set", path: ["provider"], value: desired.provider },
					{ op: "set", path: ["model"], value: desired.model }
				], this.draftRevision);
				if (generation !== this.saveGeneration) return;
				const landed = routeKey(this.current()) === routeKey(desired);
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
				this.catalogPartial = false;
				this.publish();
				const response = await this.ctx.remote.session.modelCatalog();
				if (generation !== this.catalogGeneration || this.disposed) return;
				if (response.ok) {
					this.catalogGroups = response.value.groups;
					this.catalogPartial = response.value.failures.length > 0;
					this.catalogStatus = "ready";
				} else this.catalogStatus = "error";
				this.publish();
			}

			projection() {
				const snapshot = this.scope.getSnapshot();
				const desired = this.desired();
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable,
					dirty: this.draft !== undefined && routeKey(this.draft) !== routeKey(this.current()),
					invalid: this.conflicted,
					saving: this.saving,
					failed: this.failed,
					selectedKey: routeKey(desired),
					options: this.options(),
					catalogStatus: this.catalogStatus,
					catalogPartial: this.catalogPartial,
					conflicted: this.conflicted
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
		const selectStyle = {
			width: "100%",
			maxWidth: 480,
			padding: "6px 8px",
			font: "inherit",
			color: "inherit",
			background: "transparent",
			border: "1px solid var(--dsw-alias-border-primary, currentColor)",
			borderRadius: 6
		};

		/** Render the one-liner or the evaluator-model form, as the Plugins page asks. */
		function AutoEffortCard(props) {
			const { t } = props;
			const state = props.useAutoEffortCard((snapshot) => snapshot);
			if (props.view === "summary") return t("description");
			const { groups, missing } = state.options;
			const children = [];
			for (const group of groups) {
				if (group.models.length === 0) continue;
				children.push(jsx("optgroup", {
					label: group.name,
					children: group.models.map((option) => jsx("option", { value: option.key, children: option.name }, option.key))
				}, group.id));
			}
			for (const option of missing) {
				children.push(jsx("option", { value: option.key, children: `${option.provider}/${option.model} (${t("unavailable")})` }, option.key));
			}
			return jsx(SettingsForm, {
				labels: {
					unavailable: t("unavailablePlugin"),
					readOnly: t("readOnly"),
					saveFailed: t("saveFailed"),
					save: t("save"),
					saving: t("saving")
				},
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children: jsxs("div", {
					style: { display: "flex", flexDirection: "column", gap: 8 },
					children: [
						jsx("label", { htmlFor: "plugin-config-auto-effort-model", children: t("evaluator") }),
						jsx("select", {
							id: "plugin-config-auto-effort-model",
							style: selectStyle,
							value: state.selectedKey,
							disabled: !state.writable || state.saving,
							onChange: (event) => props.select(event.target.value),
							children
						}),
						jsx("p", { style: noteStyle, children: t("evaluatorHint") }),
						state.catalogStatus === "loading" ? jsx("p", { style: noteStyle, role: "status", children: t("loading") }) : null,
						state.catalogStatus === "error" ? jsxs("p", {
							style: errorStyle,
							role: "alert",
							children: [t("loadFailed"), " ", jsx("button", {
								type: "button",
								onClick: props.retryCatalog,
								style: { color: "var(--dsw-alias-brand-primary)", background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit" },
								children: t("retry")
							})]
						}) : null,
						state.catalogPartial ? jsx("p", { style: noteStyle, children: t("partial") }) : null,
						state.conflicted ? jsx("p", { style: errorStyle, role: "status", children: t("conflict") }) : null
					]
				})
			});
		}

		/** Required services (cordis fiber inject). */
		const inject = ["slots", "locale", "remote", "remote.session", "configForms"];

		/** Mount the evaluator-model card while the Host serves the `auto-effort` namespace. */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "auto-effort: dictionaries");
			const card = new AutoEffortCardController(ctx.configForms.get(AUTO_EFFORT_NS), ctx);
			const face = card.inject();
			ctx.effect(() => ctx.remote.$on("llm/adapters-updated", () => card.refreshCatalog()), "auto-effort: adapter invalidations");
			ctx.effect(() => ctx.remote.$on("settings/document-updated", () => card.refreshCatalog()), "auto-effort: settings invalidations");
			ctx.effect(() => ctx.on("connection/reset", () => card.resetConnection()), "auto-effort: connection generation");
			ctx.effect(() => () => card.dispose(), "auto-effort: form subscription");
			ctx.effect(() => ctx.configForms.whileServed([AUTO_EFFORT_NS], () => ctx.slots.inject("plugins.item", () => ctx.slots.register({
				name: "plugins.item",
				id: "auto-effort",
				order: 100,
				label: () => t("title"),
				locale: NS,
				inject: () => face
			}, AutoEffortCard))), "auto-effort: page");
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
