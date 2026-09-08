import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const descriptorPath = "contracts/models/conversation.json";
const outputPaths = {
  typescript: "src/contracts/conversation.ts",
  dart: "contracts/generated/dart/conversation.dart",
};

const expectedThreadNameValidation = {
  "minLength": 1,
  "maxLength": 100,
  "lengthUnit": "unicode_scalar_values",
  "normalization": "reject_untrimmed",
  "malformedUnicode": "reject",
  "whitespaceCodePoints": [
    9,
    10,
    11,
    12,
    13,
    32,
    133,
    160,
    5760,
    8192,
    8193,
    8194,
    8195,
    8196,
    8197,
    8198,
    8199,
    8200,
    8201,
    8202,
    8232,
    8233,
    8239,
    8287,
    12288,
    65279
  ]
};

const expectedThreadLifecycle = {
  "name": "ThreadLifecycle",
  "description": "Shared thread close/lock metadata. Absence means legacy open/unlocked and never clears administrative archive. Unlocking leaves the closure pair intact. Hiding is computed discovery policy, not stored state.",
  "fields": [
    {
      "name": "revision",
      "type": "positiveSafeInteger",
      "presence": "required"
    },
    {
      "name": "locked",
      "type": "boolean",
      "presence": "required"
    }
  ],
  "revisionValidation": {
    "minimum": 1,
    "maximum": 9007199254740991,
    "mustBeSafeInteger": true
  },
  "closureState": {
    "open": [
      {
        "name": "closedAt",
        "type": "IsoTimestamp",
        "presence": "never"
      },
      {
        "name": "closedByUserId",
        "type": "UserId",
        "presence": "never"
      }
    ],
    "closed": [
      {
        "name": "closedAt",
        "type": "IsoTimestamp",
        "presence": "required"
      },
      {
        "name": "closedByUserId",
        "type": "UserId",
        "presence": "required"
      }
    ]
  },
  "rules": {
    "openLocked": false,
    "closedLocked": "boolean",
    "unknownFields": "reject",
    "nullFields": "reject",
    "archiveIndependent": true,
    "legacyAbsence": "open_unlocked"
  }
};

const expectedShape = {
  enums: [
    { name: "ConversationType", values: ["channel", "direct", "group_direct", "thread"] },
    { name: "ConversationVisibility", values: ["public", "private"] },
  ],
  hostEntityReference: {
    name: "HostEntityReference",
    fields: ["type:string", "id:string"],
  },
  sharedFields: [
    "id:ConversationId",
    "tenantId:TenantId",
    "createdAt:IsoTimestamp",
    "updatedAt:IsoTimestamp",
  ],
  archiveState: {
    active: ["archivedAt:IsoTimestamp:never", "archivedByUserId:UserId:never"],
    archived: [
      "archivedAt:IsoTimestamp:required",
      "archivedByUserId:UserId:required",
    ],
  },
  variants: [
    {
      name: "ChannelConversation",
      wireType: "channel",
      fields: [
        "threadLifecycle:ThreadLifecycle:never:*",
        "name:string:required:*",
        "visibility:ConversationVisibility:required:*",
        "entity:HostEntityReference:optional:*",
        "parentConversationId:ConversationId:never:*",
        "rootMessageId:MessageId:never:*",
      ],
    },
    {
      name: "DirectConversation",
      wireType: "direct",
      fields: [
        "threadLifecycle:ThreadLifecycle:never:*",
        "visibility:ConversationVisibility:required:private",
        "name:string:never:*",
        "entity:HostEntityReference:never:*",
        "parentConversationId:ConversationId:never:*",
        "rootMessageId:MessageId:never:*",
      ],
    },
    {
      name: "GroupDirectConversation",
      wireType: "group_direct",
      fields: [
        "threadLifecycle:ThreadLifecycle:never:*",
        "visibility:ConversationVisibility:required:private",
        "name:string:never:*",
        "entity:HostEntityReference:never:*",
        "parentConversationId:ConversationId:never:*",
        "rootMessageId:MessageId:never:*",
      ],
    },
    {
      name: "ThreadConversation",
      wireType: "thread",
      fields: [
        "threadLifecycle:ThreadLifecycle:optional:*",
        "visibility:ConversationVisibility:required:*",
        "parentConversationId:ConversationId:required:*",
        "rootMessageId:MessageId:required:*",
        "name:string:optional:*",
        "entity:HostEntityReference:never:*",
      ],
    },
  ],
  union: {
    name: "Conversation",
    variants: [
      "ChannelConversation",
      "DirectConversation",
      "GroupDirectConversation",
      "ThreadConversation",
    ],
  },
};

export async function readConversationDescriptor(root = repositoryRoot) {
  const source = await readFile(resolve(root, descriptorPath), "utf8");
  const descriptor = JSON.parse(source);
  validateDescriptor(descriptor);
  return descriptor;
}

export function generateTypeScript(descriptor) {
  validateDescriptor(descriptor);

  const conversationType = descriptor.enums[0];
  const visibility = descriptor.enums[1];
  const host = descriptor.hostEntityReference;
  const lines = [
    "// Generated by scripts/generate-conversations.mjs from contracts/models/conversation.json.",
    "// Do not edit this file directly.",
    "",
    "import type {",
    "  ConversationId,",
    "  IsoTimestamp,",
    "  MessageId,",
    "  TenantId,",
    "  UserId,",
    '} from "./identifiers.js";',
    "",
    `export type ${conversationType.name} =`,
    ...conversationType.values.map(
      (value, index) => `  | ${JSON.stringify(value)}${index === conversationType.values.length - 1 ? ";" : ""}`,
    ),
    "",
    `export type ${visibility.name} = ${visibility.values
      .map(JSON.stringify)
      .join(" | ")};`,
    "",
    `/** ${host.description} */`,
    `export interface ${host.name} {`,
    ...host.fields.map((field) => `  readonly ${field.name}: ${field.type};`),
    "}",
    "",
    "interface ConversationBase {",
    ...descriptor.sharedFields.map(
      (field) => `  readonly ${field.name}: ${field.type};`,
    ),
    "}",
    "",
    "type ConversationArchiveState =",
    "  | {",
    ...descriptor.archiveState.active.map(
      (field) => `      readonly ${field.name}?: never;`,
    ),
    "    }",
    "  | {",
    ...descriptor.archiveState.archived.map(
      (field) => `      readonly ${field.name}: ${field.type};`,
    ),
    "    };",
    "",
  ];

  lines.push(generateTypeScriptLifecycle(descriptor), "");

  for (const variant of descriptor.variants) {
    lines.push(
      `/** ${variant.description} */`,
      `export type ${variant.name} = ConversationBase &`,
      "  ConversationArchiveState & {",
      `    readonly type: ${JSON.stringify(variant.wireType)};`,
    );
    for (const field of variant.fields) {
      const type = field.allowedValues?.length === 1
        ? JSON.stringify(field.allowedValues[0])
        : field.presence === "never"
          ? "never"
          : field.type;
      lines.push(
        `    readonly ${field.name}${field.presence === "required" ? "" : "?"}: ${type};`,
      );
    }
    lines.push("  };", "");
  }

  lines.push(`export type ${descriptor.union.name} =`);
  descriptor.union.variants.forEach((variant, index) => {
    lines.push(
      `  | ${variant}${index === descriptor.union.variants.length - 1 ? ";" : ""}`,
    );
  });

  lines.push("", generateTypeScriptNameValidation(descriptor));
  return `${lines.join("\n").trimEnd()}\n`;
}

function generateTypeScriptLifecycle(descriptor) {
  const rule = descriptor.threadLifecycle.revisionValidation;
  return `/** ${descriptor.threadLifecycle.description} */
export type ThreadLifecycle = { readonly revision: number } & (
  | {
      readonly locked: false;
      readonly closedAt?: never;
      readonly closedByUserId?: never;
    }
  | {
      readonly locked: boolean;
      readonly closedAt: IsoTimestamp;
      readonly closedByUserId: UserId;
    }
);

/** Validate supplied lifecycle metadata. Absence is handled at conversation level. */
export function validateThreadLifecycle(value: unknown): ThreadLifecycle {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("ThreadLifecycle must be a JSON object.");
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set(["revision", "locked", "closedAt", "closedByUserId"]);
  if (Object.keys(object).some((key) => !allowed.has(key))) {
    throw new TypeError("ThreadLifecycle contains an unknown field.");
  }
  const has = (key: string) => Object.prototype.hasOwnProperty.call(object, key);
  const revision = object.revision;
  if (!has("revision") || typeof revision !== "number" ||
      !Number.isSafeInteger(revision) || revision < ${rule.minimum} || revision > ${rule.maximum}) {
    throw new TypeError("ThreadLifecycle.revision must be a positive safe integer.");
  }
  if (!has("locked") || typeof object.locked !== "boolean") {
    throw new TypeError("ThreadLifecycle.locked must be a boolean.");
  }
  const hasClosedAt = has("closedAt");
  if (hasClosedAt !== has("closedByUserId")) {
    throw new TypeError("ThreadLifecycle.closedAt and closedByUserId must be provided together.");
  }
  if (!hasClosedAt) {
    if (object.locked) throw new TypeError("A locked thread must be closed.");
    return { revision, locked: false };
  }
  // Match the canonical identifier/timestamp wire convention: string values.
  if (typeof object.closedAt !== "string" || typeof object.closedByUserId !== "string") {
    throw new TypeError("ThreadLifecycle closure fields must be strings.");
  }
  return {
    revision,
    locked: object.locked,
    closedAt: object.closedAt as IsoTimestamp,
    closedByUserId: object.closedByUserId as UserId,
  };
}

/** Validate only the conversation's lifecycle field; does not parse a snapshot.
 * Preserve absence instead of materializing an open state or changing archive.
 */
export function validateConversationThreadLifecycle(conversation: {
  readonly type: ConversationType;
  readonly threadLifecycle?: unknown;
}): ThreadLifecycle | undefined {
  if (!Object.prototype.hasOwnProperty.call(conversation, "threadLifecycle")) return undefined;
  if (conversation.type !== "thread") {
    throw new TypeError("threadLifecycle is only allowed on thread conversations.");
  }
  return validateThreadLifecycle(conversation.threadLifecycle);
}
`;
}

function threadNameValidation(descriptor) {
  return descriptor.variants.find((variant) => variant.wireType === "thread")
    .fields.find((field) => field.name === "name").validation;
}

function generateTypeScriptNameValidation(descriptor) {
  const rule = threadNameValidation(descriptor);
  return `/**
 * Validate a supplied canonical thread name; absence is handled by the caller.
 * Reject untrimmed input; never normalize it. Count Unicode scalar values,
 * not UTF-16 units or grapheme clusters; reject unpaired surrogates.
 * Whitespace is Unicode White_Space plus U+FEFF, frozen in the descriptor.
 */
export function validateThreadConversationName(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("ThreadConversation.name must be a string.");
  }
  const characters = Array.from(value);
  const whitespace = new Set<number>(${JSON.stringify(rule.whitespaceCodePoints)});
  if (
    characters.length < ${rule.minLength} || characters.length > ${rule.maxLength} ||
    characters.some((character) => {
      const point = character.codePointAt(0)!;
      return point >= 0xd800 && point <= 0xdfff;
    }) ||
    whitespace.has(characters[0]!.codePointAt(0)!) ||
    whitespace.has(characters[characters.length - 1]!.codePointAt(0)!)
  ) {
    throw new TypeError("ThreadConversation.name must be trimmed and contain ${rule.minLength}–${rule.maxLength} Unicode scalar values.");
  }
  return value;
}
`;
}

function generateDartLifecycle(descriptor) {
  const rule = descriptor.threadLifecycle.revisionValidation;
  return `/// ${descriptor.threadLifecycle.description}
final class ThreadLifecycle {
  ThreadLifecycle({
    required this.revision,
    required this.locked,
    this.closedAt,
    this.closedByUserId,
  }) {
    _readThreadLifecycleRevision(revision);
    if ((closedAt == null) != (closedByUserId == null)) {
      throw ArgumentError('closedAt and closedByUserId must be provided together.');
    }
    if (locked && closedAt == null) {
      throw ArgumentError('A locked thread must be closed.');
    }
  }

  factory ThreadLifecycle.fromJson(Object? json) {
    final object = _readObject(json, 'ThreadLifecycle');
    _ensureAllowedFields(object,
        const {'revision', 'locked', 'closedAt', 'closedByUserId'},
        'ThreadLifecycle');
    final revision = _readThreadLifecycleRevision(
        _readRequired(object, 'revision', 'ThreadLifecycle'));
    final locked = _readRequired(object, 'locked', 'ThreadLifecycle');
    if (locked is! bool) {
      throw const FormatException('ThreadLifecycle.locked must be a boolean.');
    }
    final hasClosedAt = object.containsKey('closedAt');
    if (hasClosedAt != object.containsKey('closedByUserId')) {
      throw const FormatException('closedAt and closedByUserId must be provided together.');
    }
    if (locked && !hasClosedAt) {
      throw const FormatException('A locked thread must be closed.');
    }
    return ThreadLifecycle(
      revision: revision,
      locked: locked,
      closedAt: hasClosedAt ? IsoTimestamp.fromJson(object['closedAt']) : null,
      closedByUserId: hasClosedAt ? UserId.fromJson(object['closedByUserId']) : null,
    );
  }

  final int revision;
  final bool locked;
  final IsoTimestamp? closedAt;
  final UserId? closedByUserId;

  Map<String, Object?> toJson() => {
        'revision': revision,
        'locked': locked,
        if (closedAt case final closedAt?) 'closedAt': closedAt.toJson(),
        if (closedByUserId case final closedByUserId?)
          'closedByUserId': closedByUserId.toJson(),
      };
}

int _readThreadLifecycleRevision(Object? value) {
  if (value is! int || value < ${rule.minimum} || value > ${rule.maximum}) {
    throw const FormatException('ThreadLifecycle.revision must be a positive safe integer.');
  }
  return value;
}
`;
}

export function generateDart(descriptor) {
  validateDescriptor(descriptor);

  const nameRule = threadNameValidation(descriptor);
  const conversationType = descriptor.enums[0];
  const visibility = descriptor.enums[1];
  const host = descriptor.hostEntityReference;
  const variants = Object.fromEntries(
    descriptor.variants.map((variant) => [variant.wireType, variant]),
  );
  const enumCases = (values) =>
    values
      .map(
        (value, index) =>
          `  ${toDartName(value)}('${value}')${index === values.length - 1 ? ";" : ","}`,
      )
      .join("\n");
  const enumReads = (enumName, values) =>
    values
      .map((value) => `        '${value}' => ${enumName}.${toDartName(value)},`)
      .join("\n");
  const allowedFields = (variant) => [
    ...descriptor.sharedFields.map((field) => field.name),
    ...descriptor.archiveState.archived.map((field) => field.name),
    "type",
    ...variant.fields
      .filter((field) => field.presence !== "never")
      .map((field) => field.name),
  ];
  const renderAllowed = (variant) =>
    allowedFields(variant).map((field) => `          '${field}',`).join("\n");

  return `// Generated by scripts/generate-conversations.mjs from contracts/models/conversation.json.
// Do not edit this file directly.

import 'identifiers.dart';

enum ${conversationType.name} {
${enumCases(conversationType.values)}

  const ${conversationType.name}(this.wireValue);

  static ${conversationType.name} fromJson(Object? json) => switch (json) {
${enumReads(conversationType.name, conversationType.values)}
        _ => throw FormatException(
            '${conversationType.name} has an unknown JSON value: $json.',
          ),
      };

  final String wireValue;

  String toJson() => wireValue;
}

enum ${visibility.name} {
${enumCases(visibility.values)}

  const ${visibility.name}(this.wireValue);

  static ${visibility.name} fromJson(Object? json) => switch (json) {
${enumReads(visibility.name, visibility.values)}
        _ => throw FormatException(
            '${visibility.name} has an unknown JSON value: $json.',
          ),
      };

  final String wireValue;

  String toJson() => wireValue;
}

/// ${host.description}
final class ${host.name} {
  const ${host.name}({required this.type, required this.id});

  factory ${host.name}.fromJson(Object? json) {
    final object = _readObject(json, '${host.name}');
    _ensureAllowedFields(object, const {'type', 'id'}, '${host.name}');
    return ${host.name}(
      type: _readString(
        _readRequired(object, 'type', '${host.name}'),
        '${host.name}.type',
      ),
      id: _readString(
        _readRequired(object, 'id', '${host.name}'),
        '${host.name}.id',
      ),
    );
  }

  final String type;
  final String id;

  Map<String, Object?> toJson() => {'type': type, 'id': id};
}

${generateDartLifecycle(descriptor)}
sealed class Conversation {
  Conversation._({
    required this.id,
    required this.tenantId,
    required this.createdAt,
    required this.updatedAt,
    this.archivedAt,
    this.archivedByUserId,
  }) {
    _validateArchivePair(archivedAt, archivedByUserId);
  }

  factory Conversation.fromJson(Object? json) {
    final object = _readObject(json, 'Conversation');
    final type = ${conversationType.name}.fromJson(
      _readRequired(object, 'type', 'Conversation'),
    );
    return switch (type) {
      ${conversationType.name}.channel => ChannelConversation._fromObject(object),
      ${conversationType.name}.direct => DirectConversation._fromObject(object),
      ${conversationType.name}.groupDirect =>
        GroupDirectConversation._fromObject(object),
      ${conversationType.name}.thread => ThreadConversation._fromObject(object),
    };
  }

  final ConversationId id;
  final TenantId tenantId;
  final IsoTimestamp createdAt;
  final IsoTimestamp updatedAt;
  final IsoTimestamp? archivedAt;
  final UserId? archivedByUserId;

  ${conversationType.name} get type;
  ${visibility.name} get visibility;

  Map<String, Object?> toJson();

  Map<String, Object?> _baseJson() => {
        'id': id.toJson(),
        'tenantId': tenantId.toJson(),
        'createdAt': createdAt.toJson(),
        'updatedAt': updatedAt.toJson(),
        if (archivedAt case final archivedAt?)
          'archivedAt': archivedAt.toJson(),
        if (archivedByUserId case final archivedByUserId?)
          'archivedByUserId': archivedByUserId.toJson(),
      };
}

/// ${variants.channel.description}
final class ChannelConversation extends Conversation {
  ChannelConversation({
    required super.id,
    required super.tenantId,
    required super.createdAt,
    required super.updatedAt,
    required this.name,
    required this.visibility,
    this.entity,
    super.archivedAt,
    super.archivedByUserId,
  }) : super._();

  factory ChannelConversation.fromJson(Object? json) {
    final conversation = Conversation.fromJson(json);
    if (conversation is! ChannelConversation) {
      throw const FormatException('Expected a channel conversation.');
    }
    return conversation;
  }

  factory ChannelConversation._fromObject(Map<String, Object?> object) {
    _ensureAllowedFields(
        object,
        const {
${renderAllowed(variants.channel)}
        },
        'ChannelConversation');
    final fields = _readConversationFields(object, 'ChannelConversation');
    return ChannelConversation(
      id: fields.id,
      tenantId: fields.tenantId,
      createdAt: fields.createdAt,
      updatedAt: fields.updatedAt,
      archivedAt: fields.archivedAt,
      archivedByUserId: fields.archivedByUserId,
      name: _readString(
        _readRequired(object, 'name', 'ChannelConversation'),
        'ChannelConversation.name',
      ),
      visibility: ${visibility.name}.fromJson(
        _readRequired(object, 'visibility', 'ChannelConversation'),
      ),
      entity: object.containsKey('entity')
          ? ${host.name}.fromJson(object['entity'])
          : null,
    );
  }

  @override
  ${conversationType.name} get type => ${conversationType.name}.channel;

  final String name;

  @override
  final ${visibility.name} visibility;

  final ${host.name}? entity;

  @override
  Map<String, Object?> toJson() => {
        ..._baseJson(),
        'type': type.toJson(),
        'name': name,
        'visibility': visibility.toJson(),
        if (entity case final entity?) 'entity': entity.toJson(),
      };
}

/// ${variants.direct.description}
final class DirectConversation extends Conversation {
  DirectConversation({
    required super.id,
    required super.tenantId,
    required super.createdAt,
    required super.updatedAt,
    super.archivedAt,
    super.archivedByUserId,
  }) : super._();

  factory DirectConversation.fromJson(Object? json) {
    final conversation = Conversation.fromJson(json);
    if (conversation is! DirectConversation) {
      throw const FormatException('Expected a direct conversation.');
    }
    return conversation;
  }

  factory DirectConversation._fromObject(Map<String, Object?> object) {
    _ensureAllowedFields(
        object,
        const {
${renderAllowed(variants.direct)}
        },
        'DirectConversation');
    _readPrivateVisibility(object, 'DirectConversation');
    final fields = _readConversationFields(object, 'DirectConversation');
    return DirectConversation(
      id: fields.id,
      tenantId: fields.tenantId,
      createdAt: fields.createdAt,
      updatedAt: fields.updatedAt,
      archivedAt: fields.archivedAt,
      archivedByUserId: fields.archivedByUserId,
    );
  }

  @override
  ${conversationType.name} get type => ${conversationType.name}.direct;

  @override
  ${visibility.name} get visibility => ${visibility.name}.private;

  @override
  Map<String, Object?> toJson() => {
        ..._baseJson(),
        'type': type.toJson(),
        'visibility': visibility.toJson(),
      };
}

/// ${variants.group_direct.description}
final class GroupDirectConversation extends Conversation {
  GroupDirectConversation({
    required super.id,
    required super.tenantId,
    required super.createdAt,
    required super.updatedAt,
    super.archivedAt,
    super.archivedByUserId,
  }) : super._();

  factory GroupDirectConversation.fromJson(Object? json) {
    final conversation = Conversation.fromJson(json);
    if (conversation is! GroupDirectConversation) {
      throw const FormatException('Expected a group_direct conversation.');
    }
    return conversation;
  }

  factory GroupDirectConversation._fromObject(Map<String, Object?> object) {
    _ensureAllowedFields(
        object,
        const {
${renderAllowed(variants.group_direct)}
        },
        'GroupDirectConversation');
    _readPrivateVisibility(object, 'GroupDirectConversation');
    final fields = _readConversationFields(object, 'GroupDirectConversation');
    return GroupDirectConversation(
      id: fields.id,
      tenantId: fields.tenantId,
      createdAt: fields.createdAt,
      updatedAt: fields.updatedAt,
      archivedAt: fields.archivedAt,
      archivedByUserId: fields.archivedByUserId,
    );
  }

  @override
  ${conversationType.name} get type => ${conversationType.name}.groupDirect;

  @override
  ${visibility.name} get visibility => ${visibility.name}.private;

  @override
  Map<String, Object?> toJson() => {
        ..._baseJson(),
        'type': type.toJson(),
        'visibility': visibility.toJson(),
      };
}

/// ${variants.thread.description}
final class ThreadConversation extends Conversation {
  ThreadConversation({
    required super.id,
    required super.tenantId,
    required super.createdAt,
    required super.updatedAt,
    required this.visibility,
    required this.parentConversationId,
    required this.rootMessageId,
    String? name,
    this.threadLifecycle,
    super.archivedAt,
    super.archivedByUserId,
  }) : name = name == null ? null : validateThreadConversationName(name),
       super._();

  factory ThreadConversation.fromJson(Object? json) {
    final conversation = Conversation.fromJson(json);
    if (conversation is! ThreadConversation) {
      throw const FormatException('Expected a thread conversation.');
    }
    return conversation;
  }

  factory ThreadConversation._fromObject(Map<String, Object?> object) {
    _ensureAllowedFields(
        object,
        const {
${renderAllowed(variants.thread)}
        },
        'ThreadConversation');
    final fields = _readConversationFields(object, 'ThreadConversation');
    return ThreadConversation(
      id: fields.id,
      tenantId: fields.tenantId,
      createdAt: fields.createdAt,
      updatedAt: fields.updatedAt,
      archivedAt: fields.archivedAt,
      archivedByUserId: fields.archivedByUserId,
      visibility: ${visibility.name}.fromJson(
        _readRequired(object, 'visibility', 'ThreadConversation'),
      ),
      parentConversationId: ConversationId.fromJson(
        _readRequired(object, 'parentConversationId', 'ThreadConversation'),
      ),
      rootMessageId: MessageId.fromJson(
        _readRequired(object, 'rootMessageId', 'ThreadConversation'),
      ),
      threadLifecycle: object.containsKey('threadLifecycle')
          ? ThreadLifecycle.fromJson(object['threadLifecycle'])
          : null,
      name: object.containsKey('name')
          ? validateThreadConversationName(object['name'])
          : null,
    );
  }

  @override
  ${conversationType.name} get type => ${conversationType.name}.thread;

  @override
  final ${visibility.name} visibility;

  final ConversationId parentConversationId;
  final MessageId rootMessageId;
  final String? name;
  final ThreadLifecycle? threadLifecycle;

  @override
  Map<String, Object?> toJson() => {
        ..._baseJson(),
        'type': type.toJson(),
        'visibility': visibility.toJson(),
        'parentConversationId': parentConversationId.toJson(),
        'rootMessageId': rootMessageId.toJson(),
        if (name case final name?) 'name': name,
        if (threadLifecycle case final lifecycle?)
          'threadLifecycle': lifecycle.toJson(),
      };
}

/// Validate a supplied canonical thread name; absence is handled by the caller.
/// Reject untrimmed input without normalization. Count Unicode scalar values,
/// not UTF-16 units or grapheme clusters; reject unpaired surrogates.
/// Whitespace is Unicode White_Space plus U+FEFF, frozen in the descriptor.
String validateThreadConversationName(Object? value) {
  if (value is! String) {
    throw const FormatException('ThreadConversation.name must be a string.');
  }
  final characters = value.runes.toList();
  const whitespace = <int>{${nameRule.whitespaceCodePoints.join(", ")}};
  if (${nameRule.minLength === 1 ? "characters.isEmpty" : `characters.length < ${nameRule.minLength}`} ||
      characters.length > ${nameRule.maxLength} ||
      characters.any((point) => point >= 0xd800 && point <= 0xdfff) ||
      whitespace.contains(characters.first) ||
      whitespace.contains(characters.last)) {
    throw const FormatException(
      'ThreadConversation.name must be trimmed and contain ${nameRule.minLength}–${nameRule.maxLength} Unicode scalar values.',
    );
  }
  return value;
}

final class _ConversationFields {
  const _ConversationFields({
    required this.id,
    required this.tenantId,
    required this.createdAt,
    required this.updatedAt,
    required this.archivedAt,
    required this.archivedByUserId,
  });

  final ConversationId id;
  final TenantId tenantId;
  final IsoTimestamp createdAt;
  final IsoTimestamp updatedAt;
  final IsoTimestamp? archivedAt;
  final UserId? archivedByUserId;
}

_ConversationFields _readConversationFields(
  Map<String, Object?> object,
  String typeName,
) {
  final archive = _readArchiveFields(object, typeName);
  return _ConversationFields(
    id: ConversationId.fromJson(_readRequired(object, 'id', typeName)),
    tenantId: TenantId.fromJson(
      _readRequired(object, 'tenantId', typeName),
    ),
    createdAt: IsoTimestamp.fromJson(
      _readRequired(object, 'createdAt', typeName),
    ),
    updatedAt: IsoTimestamp.fromJson(
      _readRequired(object, 'updatedAt', typeName),
    ),
    archivedAt: archive.archivedAt,
    archivedByUserId: archive.archivedByUserId,
  );
}

final class _ArchiveFields {
  const _ArchiveFields({this.archivedAt, this.archivedByUserId});

  final IsoTimestamp? archivedAt;
  final UserId? archivedByUserId;
}

_ArchiveFields _readArchiveFields(
  Map<String, Object?> object,
  String typeName,
) {
  final hasArchivedAt = object.containsKey('archivedAt');
  final hasArchivedBy = object.containsKey('archivedByUserId');
  if (hasArchivedAt != hasArchivedBy) {
    throw FormatException(
      '$typeName.archivedAt and archivedByUserId must be provided together.',
    );
  }
  if (!hasArchivedAt) return const _ArchiveFields();
  return _ArchiveFields(
    archivedAt: IsoTimestamp.fromJson(object['archivedAt']),
    archivedByUserId: UserId.fromJson(object['archivedByUserId']),
  );
}

void _validateArchivePair(
  IsoTimestamp? archivedAt,
  UserId? archivedByUserId,
) {
  if ((archivedAt == null) != (archivedByUserId == null)) {
    throw ArgumentError(
      'archivedAt and archivedByUserId must be provided together.',
    );
  }
}

void _readPrivateVisibility(
  Map<String, Object?> object,
  String typeName,
) {
  final visibility = ${visibility.name}.fromJson(
    _readRequired(object, 'visibility', typeName),
  );
  if (visibility != ${visibility.name}.private) {
    throw FormatException('$typeName.visibility must be private.');
  }
}

Map<String, Object?> _readObject(Object? json, String typeName) {
  if (json is! Map<Object?, Object?>) {
    throw FormatException('$typeName must be a JSON object.');
  }
  final object = <String, Object?>{};
  for (final entry in json.entries) {
    final key = entry.key;
    if (key is! String) {
      throw FormatException('$typeName keys must be strings.');
    }
    object[key] = entry.value;
  }
  return object;
}

void _ensureAllowedFields(
  Map<String, Object?> object,
  Set<String> allowed,
  String typeName,
) {
  for (final field in object.keys) {
    if (!allowed.contains(field)) {
      throw FormatException('$typeName.$field is not allowed.');
    }
  }
}

Object? _readRequired(
  Map<String, Object?> object,
  String field,
  String typeName,
) {
  if (!object.containsKey(field)) {
    throw FormatException('$typeName.$field is required.');
  }
  return object[field];
}

String _readString(Object? json, String fieldName) {
  if (json is! String) {
    throw FormatException('$fieldName must be a string JSON value.');
  }
  return json;
}
`;
}

export async function generateConversations({
  check = false,
  root = repositoryRoot,
} = {}) {
  const descriptor = await readConversationDescriptor(root);
  const outputs = {
    [outputPaths.typescript]: generateTypeScript(descriptor),
    [outputPaths.dart]: generateDart(descriptor),
  };
  const drifted = [];

  for (const [path, generated] of Object.entries(outputs)) {
    const absolutePath = resolve(root, path);
    if (check) {
      let existing;
      try {
        existing = await readFile(absolutePath, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (existing !== generated) drifted.push(path);
      continue;
    }

    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, generated, "utf8");
  }

  return drifted;
}

function validateDescriptor(descriptor) {
  if (descriptor?.schemaVersion !== 1) {
    throw new Error("conversation.json must use schemaVersion 1");
  }

  if (JSON.stringify(descriptor.threadLifecycle) !== JSON.stringify(expectedThreadLifecycle)) {
    throw new Error("conversation.json must define exactly the canonical thread lifecycle contract");
  }

  const threadName = descriptor.variants?.find((variant) => variant.name === "ThreadConversation")
    ?.fields?.find((field) => field.name === "name");
  if (JSON.stringify(threadName?.validation) !== JSON.stringify(expectedThreadNameValidation)) {
    throw new Error("ThreadConversation.name must define exactly the canonical name validation");
  }

  const shape = {
    enums: descriptor.enums?.map((enumeration) => ({
      name: enumeration?.name,
      values: enumeration?.values,
    })),
    hostEntityReference: {
      name: descriptor.hostEntityReference?.name,
      fields: descriptor.hostEntityReference?.fields?.map(fieldSignature),
    },
    sharedFields: descriptor.sharedFields?.map(fieldSignature),
    archiveState: {
      active: descriptor.archiveState?.active?.map(archiveFieldSignature),
      archived: descriptor.archiveState?.archived?.map(archiveFieldSignature),
    },
    variants: descriptor.variants?.map((variant) => ({
      name: variant?.name,
      wireType: variant?.wireType,
      fields: variant?.fields?.map(variantFieldSignature),
    })),
    union: {
      name: descriptor.union?.name,
      variants: descriptor.union?.variants,
    },
  };
  if (JSON.stringify(shape) !== JSON.stringify(expectedShape)) {
    throw new Error(
      "conversation.json must define exactly the shared conversation union contract",
    );
  }

  const described = [
    descriptor.hostEntityReference,
    ...descriptor.variants,
  ];
  for (const type of described) {
    if (typeof type.description !== "string" || type.description.length === 0) {
      throw new Error(`${type.name} must have a description`);
    }
  }
}

function fieldSignature(field) {
  return `${field?.name}:${field?.type}`;
}

function archiveFieldSignature(field) {
  return `${fieldSignature(field)}:${field?.presence}`;
}

function variantFieldSignature(field) {
  return `${archiveFieldSignature(field)}:${field?.allowedValues?.join(",") ?? "*"}`;
}

function toDartName(value) {
  return value.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function parseArguments(args) {
  let check = false;
  let root = repositoryRoot;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") {
      check = true;
    } else if (argument === "--root") {
      const value = args[index + 1];
      if (!value) throw new Error("--root requires a path");
      root = resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return { check, root };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const drifted = await generateConversations(options);
  if (options.check && drifted.length > 0) {
    console.error(
      `Generated conversation contracts are out of date:\n${drifted
        .map((path) => `- ${relative(options.root, resolve(options.root, path))}`)
        .join("\n")}\nRun npm run generate:conversations.`,
    );
    process.exitCode = 1;
  } else if (options.check) {
    console.log("Generated conversation contracts are up to date.");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
