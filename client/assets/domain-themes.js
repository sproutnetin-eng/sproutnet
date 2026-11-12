// Domain-themed gradient covers for problems without an uploaded image.
//
// Cards (problems.html) and the detail hero (problem-detail.html) always render
// a 16:9 cover: the uploaded `thumbnail_url` when present, otherwise a gradient
// matched to the problem's domain with the domain name written on it — so every
// problem shows a relevant cover even when the poster skips the upload step.
// No external images involved; pure CSS. The API keeps returning the stored
// value (null when missing); the fallback lives here so existing rows need no
// migration or backfill.
export const DOMAIN_THEMES = {
  'AI & Data': 'linear-gradient(135deg, #1E1B4B 0%, #4C1D95 60%, #6D28D9 100%)',
  'Climate': 'linear-gradient(135deg, #1B4332 0%, #2D6A4F 60%, #52B788 100%)',
  'Public Infrastructure': 'linear-gradient(135deg, #1C1917 0%, #44403C 60%, #78716C 100%)',
  'Healthcare': 'linear-gradient(135deg, #0C4A6E 0%, #0284C7 60%, #38BDF8 100%)',
  'Agriculture': 'linear-gradient(135deg, #3F6212 0%, #65A30D 60%, #A3E635 100%)',
  'Education': 'linear-gradient(135deg, #7C2D12 0%, #EA580C 60%, #FBBF24 100%)',
  'Urban Mobility': 'linear-gradient(135deg, #4C0519 0%, #BE123C 60%, #FB7185 100%)',
  'Civic Technology': 'linear-gradient(135deg, #134E4A 0%, #0D9488 60%, #5EEAD4 100%)',
};

export const DEFAULT_DOMAIN_THEME = DOMAIN_THEMES['AI & Data'];

export function domainTheme(domain) {
  return DOMAIN_THEMES[domain] || DEFAULT_DOMAIN_THEME;
}
