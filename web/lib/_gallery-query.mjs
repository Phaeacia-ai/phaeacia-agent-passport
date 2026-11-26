export function searchText(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120).replace(/[\uD800-\uDFFF]/gu, '\uFFFD') : '';
}
export function matchesSearch(card, query) {
  return [card.title, card.summary].some(value => String(value || '').toLowerCase().includes(query.toLowerCase()));
}
