import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ChevronDown, Check, Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  isSupportedLocale,
  stripLocalePrefix,
  withLocalePrefix,
} from "./LocaleResolver";
import type { SupportedLocale } from "../i18n/glossary";
import {
  LANGUAGE_PICKER_ENABLED,
  VISIBLE_LOCALES,
} from "../i18n/localeConfig";
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

/**
 * Language list shown in the dropdown. Pulled from `localeConfig.ts`
 * via `VISIBLE_LOCALES`, which is the subset of `SUPPORTED_LOCALES`
 * with `visible: true` — so placeholder locales (added to
 * SUPPORTED_LOCALES but not yet translated) are filtered out.
 */
const LANGUAGES = VISIBLE_LOCALES;

/**
 * Public entry point. Wraps the actual implementation so the master
 * switch (`LANGUAGE_PICKER_ENABLED`) can short-circuit to `null`
 * without triggering React's rules-of-hooks lint (the inner
 * component carries the hooks). URL-based locale routing
 * (`/es/...`, `/ta/...`) keeps working when the picker is hidden —
 * users with bookmarks or hreflang-discovered URLs land on the
 * right locale regardless of whether the picker is visible.
 */
export function LanguagePicker() {
  if (!LANGUAGE_PICKER_ENABLED) return null;
  return <LanguagePickerInner />;
}

function LanguagePickerInner() {
  const { i18n, t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
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
    if (!isSupportedLocale(next)) return;
    const target: SupportedLocale = next;
    void i18n.changeLanguage(target);

    // Rewrite the URL to carry the new locale prefix (or strip it
    // when switching back to English). Preserves the rest of the path
    // plus any search params and hash fragment so a deep link still
    // points at the same page after the language change.
    const stripped = stripLocalePrefix(location.pathname);
    const newPath = withLocalePrefix(stripped, target);
    if (newPath !== location.pathname) {
      navigate(`${newPath}${location.search}${location.hash}`, { replace: false });
    }
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
