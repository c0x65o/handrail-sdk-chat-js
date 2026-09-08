# Canonical thread names

`contracts/models/conversation.json` permits an omitted thread `name` for legacy
records and callers. A supplied value must be a string of 1–100 Unicode scalar
values. Supplementary characters count once; combining marks count separately.
Unpaired UTF-16 surrogates are invalid. No NFC or grapheme normalization occurs.

Canonical validation **rejects untrimmed values**, without modifying input.
Leading/trailing whitespace is the descriptor's frozen Unicode White_Space set
(U+0009–000D, U+0020, U+0085, U+00A0, U+1680, U+2000–200A, U+2028–2029,
U+202F, U+205F, U+3000), plus U+FEFF. This deliberately avoids differences
between JavaScript and Dart native `trim`. Internal whitespace is preserved.
U+200B and U+180E are not whitespace under this contract.

Both generated models expose `validateThreadConversationName` for a supplied
value. It returns the unchanged valid string or throws. TypeScript models remain
structural (`name?: string`); the helper validates values that types cannot prove.
Dart's constructor validates non-null names; its nullable optional argument uses
null for absence and omits it on serialization. JSON must omit an absent name;
explicit JSON null, numbers, booleans, arrays and objects are rejected.

Channel names remain required with their existing rules. Direct/group-direct
names remain forbidden. Thread parent/root identity, visibility, entity
restrictions and paired archive fields are unchanged. This contract foundation
does not wire validation into creation, storage or snapshot boundaries; those
are separate dependent tasks. Lifecycle metadata must be added after this change
because it shares the conversation descriptor and generator.
