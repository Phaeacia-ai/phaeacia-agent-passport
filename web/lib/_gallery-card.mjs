/* Shared fact-to-copy mapping for the HTML gallery and its public JSON contract. */
export const galleryWarning = card => card.owner_confirmed === true ? null : 'Did not confirm this description';
