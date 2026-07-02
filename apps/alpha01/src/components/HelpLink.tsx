const BASIC_GUIDE = 'https://www.vaipakam.com/help/basic';

export function HelpLink({ anchor, label = 'Learn more in the Basic guide' }: { anchor: string; label?: string }) {
  return (
    <a href={`${BASIC_GUIDE}#${anchor}`} target="_blank" rel="noreferrer" style={{ fontSize: '0.9rem' }}>
      {label}
    </a>
  );
}