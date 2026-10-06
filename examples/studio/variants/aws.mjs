// Variant `aws`: specified, not built. The recipe is written down in docs/architecture/HOST-RECIPE-AWS.md; there is no code, so
// the selector lists it as unavailable and points there.
export default () => ({
  id: 'aws', title: 'AWS', order: 90,
  description: 'Specified, not built: a host recipe for AWS. See docs/architecture/HOST-RECIPE-AWS.md.',
  available: { reason: 'Specified, not built. See docs/architecture/HOST-RECIPE-AWS.md.' },
  capabilities: [],
  link: 'docs/architecture/HOST-RECIPE-AWS.md',
});
