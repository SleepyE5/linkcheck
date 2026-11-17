/**
 * Every reason the checker can give, in one place.
 *
 * The list is the tool's contract: --allow takes one of these strings, the JSON
 * output emits one, and a reason that meant something different in two
 * versions would make a pinned CI config lie. So they are named once here and
 * nowhere else.
 */

export const REASONS = [
  'missing-file',
  'missing-from-root',
  'missing-anchor',
  'missing-reference',
  'empty-destination',
  'malformed-url',
  'malformed-anchor',
  'unusable-image-url',
  'outside-root',
  'broken-url',
];

/** What the reason means, phrased for someone who has never seen this tool. */
export const REASON_HINT = {
  'missing-file': 'nothing at that path',
  'missing-from-root': 'a /link with no target under the root',
  'missing-anchor': 'no heading of that name',
  'missing-reference': 'no [label]: definition',
  'empty-destination': 'the link has no destination',
  'malformed-url': 'unreadable percent-encoding',
  'malformed-anchor': 'unreadable percent-encoding',
  'unusable-image-url': 'a browser cannot show this',
  'outside-root': 'points above the tree being checked',
  'broken-url': 'the server says it is gone',
};
