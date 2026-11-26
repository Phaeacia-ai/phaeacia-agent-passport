/* The gallery's category list: one closed list, eight slugs, purposes rather
   than capabilities. Asked once, when a passport is listed, and never at
   upload for a passport that is not being listed.

   Raffael edits this list; the crew does not (GALLERY-SPEC.md §5, HAL,
   provisional). The slug is stored on every listed row and on every card that
   carries it, so changing a slug after launch is a migration of all of them.
   The slugs are therefore meant to be boring and permanent even if the labels
   change; change a label freely, never a slug.

   Imported by upload.mjs (the X-Passport-Category header), manage.mjs (the
   list action) and gallery.mjs (the ?category filter). upload.html and
   manage.html carry a duplicated <option> list because a static page cannot
   import a module; tools/run-tests.mjs asserts both copies match this file,
   slug for slug and label for label, so the duplication cannot drift silently. */

export const CATEGORIES = Object.freeze([
  { slug: 'research-and-monitoring',   label: 'Research and monitoring' },
  { slug: 'writing-and-editing',       label: 'Writing and editing' },
  { slug: 'personal-and-planning',     label: 'Personal and planning' },
  { slug: 'operations-and-admin',      label: 'Operations and admin' },
  { slug: 'engineering-and-dev-tools', label: 'Engineering and dev tools' },
  { slug: 'sales-and-customers',       label: 'Sales and customers' },
  { slug: 'finance-and-legal',         label: 'Finance and legal' },
  { slug: 'other',                     label: 'Something else' }
].map(Object.freeze));

const SLUGS = new Set(CATEGORIES.map(c => c.slug));

/* True only for a string that is exactly one of the slugs above. Anything
   else, including a label, a different case, or a non-string, is false: the
   slug is written into an attribute on the gallery page, and the renderer's
   rule is that an attribute is built only from a value that passed a
   membership test like this one. */
export const isCategory = slug => typeof slug === 'string' && SLUGS.has(slug);

/* The label for a stored slug, or '' for a slug this list no longer carries,
   so a row written under a retired slug renders with an empty category rather
   than an invented one. */
export function categoryLabel(slug) {
  const hit = CATEGORIES.find(c => c.slug === slug);
  return hit ? hit.label : '';
}
