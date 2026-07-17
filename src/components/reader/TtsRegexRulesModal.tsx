
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { Book } from "@/types/book";
import type {
  TtsRegexPreviewStats,
  TtsRegexRule,
  TtsRegexScope,
} from "@/types/ttsRegex";
import { useTtsRegex } from "@/contexts/TtsRegexContext";
import {
  compileRule,
  TTS_REGEX_MAX_PATTERN_LENGTH,
  TTS_REGEX_MAX_REPLACEMENT_LENGTH,
} from "@/lib/ttsRegex/engine";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  book: Book | null;
  initialPattern?: string;
  initialReplacement?: string;
};

type RuleFormState = {
  pattern: string;
  replacement: string;
  caseInsensitive: boolean;
  enabled: boolean;
};

type PendingSave = {
  scope: TtsRegexScope;
  bookId?: string;
  candidate: TtsRegexRule;
  isEditing: boolean;
  preview: TtsRegexPreviewStats;
};

const EMPTY_FORM: RuleFormState = {
  pattern: "",
  replacement: "",
  caseInsensitive: true,
  enabled: true,
};

function trimForPreview(value: string, max = 100): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

export default function TtsRegexRulesModal(props: Props) {
  const { isOpen, onClose, book, initialPattern, initialReplacement } = props;
  const {
    matchMode,
    setMatchMode,
    getRules,
    createRule,
    updateRule,
    deleteRule,
    moveRule,
    previewCandidate,
  } = useTtsRegex();

  const [scope, setScope] = useState<TtsRegexScope>("global");
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [form, setForm] = useState<RuleFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingSave, setPendingSave] = useState<PendingSave | null>(null);
  const shouldReduceMotion = useReducedMotion();

  const bookId = book?.id;

  useEffect(() => {
    if (!isOpen) return;
    if (!initialPattern && !initialReplacement) return;

    setEditingRuleId(null);
    setPendingSave(null);
    setFormError(null);
    setForm({
      ...EMPTY_FORM,
      pattern: initialPattern ?? "",
      replacement: initialReplacement ?? "",
    });
  }, [initialPattern, initialReplacement, isOpen]);

  const activeRules = useMemo(() => {
    if (scope === "book") {
      if (!bookId) return [];
      return getRules("book", bookId);
    }
    return getRules("global");
  }, [bookId, getRules, scope]);

  const clearForm = () => {
    setEditingRuleId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const startEditRule = (rule: TtsRegexRule) => {
    setEditingRuleId(rule.id);
    setForm({
      pattern: rule.pattern,
      replacement: rule.replacement,
      caseInsensitive: rule.caseInsensitive,
      enabled: rule.enabled,
    });
    setFormError(null);
  };

  const validateForm = (): string | null => {
    const pattern = form.pattern.trim();
    if (!pattern) return "Pattern is required.";
    if (pattern.length > TTS_REGEX_MAX_PATTERN_LENGTH) {
      return `Pattern is too long (max ${TTS_REGEX_MAX_PATTERN_LENGTH} chars).`;
    }
    if (form.replacement.length > TTS_REGEX_MAX_REPLACEMENT_LENGTH) {
      return `Replacement is too long (max ${TTS_REGEX_MAX_REPLACEMENT_LENGTH} chars).`;
    }
    return null;
  };

  const runPreview = () => {
    setFormError(null);

    if (!book) {
      setFormError("Preview is unavailable until book content is loaded.");
      return;
    }

    const validationError = validateForm();
    if (validationError) {
      setFormError(validationError);
      return;
    }

    const now = Date.now();
    const editingRule = editingRuleId ? activeRules.find((rule) => rule.id === editingRuleId) : null;
    const candidate: TtsRegexRule = {
      id: editingRule?.id ?? `preview-${now}`,
      pattern: form.pattern.trim(),
      replacement: form.replacement,
      source: editingRule?.source ?? "regex",
      caseInsensitive: form.caseInsensitive,
      enabled: form.enabled,
      createdAt: editingRule?.createdAt ?? now,
      updatedAt: now,
    };

    const compileResult = compileRule(candidate);
    if (!compileResult.ok) {
      setFormError(compileResult.error);
      return;
    }

    try {
      const preview = previewCandidate({
        book,
        scope,
        bookId,
        candidate,
      });

      setPendingSave({
        scope,
        bookId,
        candidate,
        isEditing: Boolean(editingRule),
        preview,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to preview rule";
      setFormError(message);
    }
  };

  const confirmSave = () => {
    if (!pendingSave) return;

    try {
      if (pendingSave.isEditing) {
        updateRule({
          scope: pendingSave.scope,
          bookId: pendingSave.bookId,
          ruleId: pendingSave.candidate.id,
            patch: {
              pattern: pendingSave.candidate.pattern,
              replacement: pendingSave.candidate.replacement,
              source: pendingSave.candidate.source,
              caseInsensitive: pendingSave.candidate.caseInsensitive,
              enabled: pendingSave.candidate.enabled,
            },
        });
      } else {
        createRule({
          scope: pendingSave.scope,
          bookId: pendingSave.bookId,
          input: {
            pattern: pendingSave.candidate.pattern,
            replacement: pendingSave.candidate.replacement,
            source: pendingSave.candidate.source,
            caseInsensitive: pendingSave.candidate.caseInsensitive,
            enabled: pendingSave.candidate.enabled,
          },
        });
      }

      clearForm();
      setPendingSave(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save rule";
      setFormError(message);
      setPendingSave(null);
    }
  };

  return (
    <AnimatePresence>
      {isOpen ? (
        <motion.div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
          initial={shouldReduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={shouldReduceMotion ? undefined : { opacity: 0 }}
        >
          <motion.div
            className="absolute inset-0 bg-black/75 backdrop-blur-md"
            onClick={onClose}
            initial={shouldReduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={shouldReduceMotion ? undefined : { opacity: 0 }}
          />

          <motion.div
            className="relative w-full max-w-2xl rounded-t-3xl sm:rounded-3xl border border-neutral-800/80 bg-neutral-950 shadow-2xl shadow-black/50 overflow-hidden"
            style={{
              maxHeight: "calc(100vh - env(safe-area-inset-top, 0px) - 8px)",
              paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 8px)",
            }}
            initial={shouldReduceMotion ? false : { y: "100%", opacity: 0, scale: 0.96 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={shouldReduceMotion ? undefined : { y: "100%", opacity: 0, scale: 0.96 }}
            transition={shouldReduceMotion
              ? { duration: 0 }
              : { type: "spring", stiffness: 280, damping: 30 }}
          >
            <div className="border-b border-neutral-800 px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-neutral-100">Pronunciation Rules (Regex)</h3>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg px-2.5 py-1.5 text-xs text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 transition-colors"
                >
                  Close
                </button>
              </div>
              <p className="mt-2 text-xs text-neutral-500">
                Rules apply live during TTS only. Stored book text is not modified.
              </p>
            </div>

            <div className="overflow-y-auto px-5 py-4 space-y-5">
              <section className="rounded-xl border border-neutral-800 bg-neutral-900/35 p-3">
                <div className="text-xs font-medium text-neutral-300 mb-2">Match strategy</div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setMatchMode("token")}
                    className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
                      matchMode === "token"
                        ? "bg-violet-500/20 text-violet-200 border border-violet-400/40"
                        : "bg-neutral-800 text-neutral-400 border border-neutral-700"
                    }`}
                  >
                    Token
                  </button>
                  <button
                    type="button"
                    onClick={() => setMatchMode("chunk")}
                    className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
                      matchMode === "chunk"
                        ? "bg-violet-500/20 text-violet-200 border border-violet-400/40"
                        : "bg-neutral-800 text-neutral-400 border border-neutral-700"
                    }`}
                  >
                    Full chunk
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-neutral-500">
                  In full-chunk mode, rules run top-to-bottom and each rule sees the text modified by previous rules.
                </p>
              </section>

              <section className="rounded-xl border border-neutral-800 bg-neutral-900/35 p-3">
                <div className="text-xs font-medium text-neutral-300 mb-2">Scope</div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setScope("global");
                      clearForm();
                    }}
                    className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
                      scope === "global"
                        ? "bg-amber-500/20 text-amber-200 border border-amber-400/40"
                        : "bg-neutral-800 text-neutral-400 border border-neutral-700"
                    }`}
                  >
                    Global
                  </button>
                  <button
                    type="button"
                    disabled={!bookId}
                    onClick={() => {
                      setScope("book");
                      clearForm();
                    }}
                    className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
                      scope === "book"
                        ? "bg-amber-500/20 text-amber-200 border border-amber-400/40"
                        : "bg-neutral-800 text-neutral-400 border border-neutral-700"
                    } disabled:opacity-40 disabled:cursor-not-allowed`}
                  >
                    This Book
                  </button>
                </div>
              </section>

              <section className="rounded-xl border border-neutral-800 bg-neutral-900/35 p-3">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-xs font-medium text-neutral-200">
                    {scope === "global" ? "Global rules" : "Book rules"}
                  </h4>
                  <span className="text-[11px] text-neutral-500">{activeRules.length} rules</span>
                </div>

                {activeRules.length === 0 ? (
                  <p className="text-xs text-neutral-500">No rules yet.</p>
                ) : (
                  <div className="space-y-2">
                    {activeRules.map((rule, index) => (
                      <div
                        key={rule.id}
                        className="rounded-lg border border-neutral-800 bg-neutral-950/80 px-3 py-2"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-xs text-neutral-200 break-words">
                              <span className="text-neutral-500">/</span>
                              {rule.pattern}
                              <span className="text-neutral-500">/</span>
                              {rule.caseInsensitive ? "i" : ""}
                            </p>
                            <p className="text-xs text-emerald-300 break-words mt-1">{rule.replacement || "(empty)"}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              updateRule({
                                scope,
                                bookId,
                                ruleId: rule.id,
                                patch: { enabled: !rule.enabled },
                              })
                            }
                            className={`rounded-md px-2 py-1 text-[10px] border transition-colors ${
                              rule.enabled
                                ? "border-emerald-500/40 text-emerald-300 bg-emerald-500/10"
                                : "border-neutral-700 text-neutral-500 bg-neutral-900"
                            }`}
                          >
                            {rule.enabled ? "Enabled" : "Disabled"}
                          </button>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            onClick={() => moveRule({ scope, bookId, ruleId: rule.id, direction: "up" })}
                            disabled={index === 0}
                            className="rounded-md border border-neutral-700 px-2 py-1 text-[10px] text-neutral-300 disabled:opacity-40"
                          >
                            Up
                          </button>
                          <button
                            type="button"
                            onClick={() => moveRule({ scope, bookId, ruleId: rule.id, direction: "down" })}
                            disabled={index === activeRules.length - 1}
                            className="rounded-md border border-neutral-700 px-2 py-1 text-[10px] text-neutral-300 disabled:opacity-40"
                          >
                            Down
                          </button>
                          <button
                            type="button"
                            onClick={() => startEditRule(rule)}
                            className="rounded-md border border-neutral-700 px-2 py-1 text-[10px] text-violet-200"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteRule({ scope, bookId, ruleId: rule.id })}
                            className="rounded-md border border-red-400/40 px-2 py-1 text-[10px] text-red-300"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="rounded-xl border border-neutral-800 bg-neutral-900/35 p-3">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-xs font-medium text-neutral-200">
                    {editingRuleId ? "Edit rule" : "Add rule"}
                  </h4>
                  {editingRuleId ? (
                    <button
                      type="button"
                      onClick={clearForm}
                      className="rounded-md border border-neutral-700 px-2 py-1 text-[10px] text-neutral-300"
                    >
                      Cancel edit
                    </button>
                  ) : null}
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-[11px] text-neutral-400 mb-1">Regex pattern</label>
                    <input
                      value={form.pattern}
                      onChange={(event) => setForm((prev) => ({ ...prev, pattern: event.target.value }))}
                      placeholder="xarqon"
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-xs text-neutral-200"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-neutral-400 mb-1">Replacement</label>
                    <input
                      value={form.replacement}
                      onChange={(event) => setForm((prev) => ({ ...prev, replacement: event.target.value }))}
                      placeholder="zar-kon"
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-xs text-neutral-200"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      id="tts-regex-case-insensitive"
                      type="checkbox"
                      checked={form.caseInsensitive}
                      onChange={(event) =>
                        setForm((prev) => ({ ...prev, caseInsensitive: event.target.checked }))
                      }
                    />
                    <label htmlFor="tts-regex-case-insensitive" className="text-xs text-neutral-300">
                      Case insensitive (`i`)
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      id="tts-regex-enabled"
                      type="checkbox"
                      checked={form.enabled}
                      onChange={(event) => setForm((prev) => ({ ...prev, enabled: event.target.checked }))}
                    />
                    <label htmlFor="tts-regex-enabled" className="text-xs text-neutral-300">
                      Enabled
                    </label>
                  </div>
                  {formError ? (
                    <p className="text-xs text-red-300 rounded-md border border-red-400/40 bg-red-950/25 px-2 py-1.5">
                      {formError}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    onClick={runPreview}
                    className="rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-200"
                  >
                    Preview and Save
                  </button>
                </div>
              </section>
            </div>
          </motion.div>

          <AnimatePresence>
            {pendingSave ? (
              <motion.div
                className="fixed inset-0 z-[60] flex items-center justify-center px-4"
                initial={shouldReduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={shouldReduceMotion ? undefined : { opacity: 0 }}
              >
                <div className="absolute inset-0 bg-black/70" onClick={() => setPendingSave(null)} />
                <motion.div
                  className="relative w-full max-w-lg rounded-2xl border border-neutral-800 bg-neutral-950 p-4 shadow-2xl shadow-black/60"
                  initial={shouldReduceMotion ? false : { scale: 0.95, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={shouldReduceMotion ? undefined : { scale: 0.95, opacity: 0 }}
                  transition={{ duration: shouldReduceMotion ? 0 : 0.2 }}
                >
                  <h4 className="text-sm font-semibold text-neutral-100">Preview Before Save</h4>
                  <div className="mt-3 space-y-1 text-xs text-neutral-300">
                    <p>Total matches: {pendingSave.preview.totalMatches}</p>
                    <p>Affected paragraphs: {pendingSave.preview.affectedParagraphs}</p>
                    <p>Unique matched words: {pendingSave.preview.uniqueMatchedWords}</p>
                    <p>
                      Match rate: {pendingSave.preview.matchPercentOfBookWords.toFixed(2)}% of
                      {" "}
                      {pendingSave.preview.totalWords} book words
                    </p>
                  </div>

                  {pendingSave.preview.highImpact ? (
                    <p className="mt-3 rounded-md border border-red-400/40 bg-red-950/25 px-2.5 py-1.5 text-xs text-red-300">
                      High impact warning: this rule changes more than 500 matches or 5% of words.
                    </p>
                  ) : null}

                  <div className="mt-3 max-h-48 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900/40 p-2">
                    {pendingSave.preview.examples.length === 0 ? (
                      <p className="text-xs text-neutral-500">No sample replacements found in current book.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {pendingSave.preview.examples.map((example, index) => (
                          <div key={`${example.before}-${index}`} className="text-xs">
                            <span className="text-neutral-300">{trimForPreview(example.before)}</span>
                            <span className="text-neutral-500"> {"->"} </span>
                            <span className="text-emerald-300">{trimForPreview(example.after)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setPendingSave(null)}
                      className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={confirmSave}
                      className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-200"
                    >
                      Confirm Save
                    </button>
                  </div>
                </motion.div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
