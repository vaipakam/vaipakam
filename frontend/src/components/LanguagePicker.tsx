import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check, Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./LanguagePicker.css";

/**
 * `<LanguagePicker>` — display-language selector. Custom-rendered
 * dropdown (not a native `<select>`) so the trigger pill + popup
 * menu match the `<ChainPicker>` look on the public Analytics page;
 * the styling lives in `LanguagePicker.css` and intentionally
 * mirrors `ChainPicker.css` rule-for-rule so the two pickers feel
 * like siblings across both surfaces.
 *
 * Selection is delegated to i18next via `i18n.changeLanguage`, which
 * also persists the choice to `localStorage["vaipakam:language"]`
 * (the same key this component used in its pre-i18n stub form, so
 * existing user preferences carry forward).
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
  { code: "ko", label: "한국어" },
  { code: "hi", label: "हिन्दी" },
  { code: "ta", label: "தமிழ்" },
  { code: "ar", label: "العربية" },
];

export function LanguagePicker() {
  const { i18n, t } = useTranslation();
  const [code, setCode] = useState<string>(i18n.resolvedLanguage ?? "en");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Mirror i18next's active language into local state so the
  // selected-tick re-renders correctly when language changes via
  // anything other than this picker (a programmatic call elsewhere,
  // a cross-tab sync from the localStorage detector, etc.).
  useEffect(() => {
    const onChange = (lng: string) => setCode(lng);
    i18n.on("languageChanged", onChange);
    return () => i18n.off("languageChanged", onChange);
  }, [i18n]);

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

  const selected = LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];

  function pick(next: string) {
    setOpen(false);
    void i18n.changeLanguage(next);
  }

  return (
    <div className="language-picker" ref={wrapRef}>
      <button
        type="button"
        className="language-picker-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("languagePicker.ariaLabel")}
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
