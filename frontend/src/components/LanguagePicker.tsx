import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check, Globe } from "lucide-react";
import "./LanguagePicker.css";

/**
 * `<LanguagePicker>` — UI stub for the upcoming multi-language
 * feature. Custom-rendered dropdown (not a native `<select>`) so
 * the trigger pill + popup menu match the `<ChainPicker>` look on
 * the public Analytics page; the styling lives in `LanguagePicker.css`
 * and intentionally mirrors `ChainPicker.css` rule-for-rule so the
 * two pickers feel like siblings across both surfaces.
 *
 * Selection persists to `localStorage["vaipakam:language"]` and a
 * `language-change` window event fires on pick so the i18n layer
 * (when it lands) can hook in without touching this component.
 *
 * Today: only English has shipped translations. The picker still
 * lists the planned languages so users can choose their preferred
 * one and have it remembered for when translations arrive.
 */

interface LanguageOption {
  code: string;
  /** Native-language label so users can locate their language even
   *  without reading English (e.g. "Español" not "Spanish"). */
  label: string;
}

const LANGUAGES: LanguageOption[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
  { code: "hi", label: "हिन्दी" },
  { code: "ar", label: "العربية" },
];

const STORAGE_KEY = "vaipakam:language";

function readInitial(): string {
  if (typeof window === "undefined") return "en";
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "en";
  } catch {
    return "en";
  }
}

export function LanguagePicker() {
  const [code, setCode] = useState<string>(readInitial);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Cross-tab sync: another tab changing the language keeps ours
  // in lockstep. Cheap consistency for a stub setting.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY && e.newValue) setCode(e.newValue);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Outside-click / Escape close — same dismissal pattern as
  // ChainPicker.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected =
    LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];

  function pick(next: string) {
    setOpen(false);
    setCode(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore quota / privacy-mode errors; in-memory state is
      // still correct for the rest of the session.
    }
    window.dispatchEvent(
      new CustomEvent("language-change", { detail: { code: next } }),
    );
  }

  return (
    <div className="language-picker" ref={wrapRef}>
      <button
        type="button"
        className="language-picker-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Display language"
      >
        <Globe size={14} aria-hidden="true" />
        <span className="language-picker-label">{selected.label}</span>
        <ChevronDown
          size={14}
          className="language-picker-chevron"
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="language-picker-menu" role="listbox">
          {LANGUAGES.map((l) => (
            <button
              key={l.code}
              type="button"
              role="option"
              aria-selected={l.code === code}
              className="language-picker-item"
              onClick={() => pick(l.code)}
            >
              <span className="language-picker-item-label">{l.label}</span>
              {l.code === code && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default LanguagePicker;
