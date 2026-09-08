import {
  createElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
} from "react";

import type {
  ConversationId,
  ConversationMemberRole,
  HostDirectoryUserSummary,
  UserId,
} from "../contracts/index.js";
import {
  useDirectorySearch,
  type ChatActions,
  type ConversationMemberView,
} from "../react/index.js";

const DIRECTORY_QUERY_DEBOUNCE_MS = 300;
const MEMBER_ROLES = Object.freeze([
  "owner",
  "moderator",
  "member",
] as const satisfies readonly ConversationMemberRole[]);

const directoryUserLabel = (user: HostDirectoryUserSummary): string => {
  if (user.kind === "active") return user.displayName;
  if (user.kind === "redacted") return "Hidden user";
  return "Unavailable user";
};

const memberLabel = (member: ConversationMemberView): string =>
  member.user === undefined ? "Unknown user" : directoryUserLabel(member.user);

const roleLabel = (role: ConversationMemberRole): string =>
  role === "owner" ? "Owner" : role === "moderator" ? "Moderator" : "Member";

const statusRegion = (message: string): ReactElement => createElement(
  "div",
  {
    className: "handrail-chat__status",
    role: "status",
    "aria-live": "polite",
  },
  message,
);

const errorRegion = (message: string): ReactElement => createElement(
  "div",
  { className: "handrail-chat__error", role: "alert" },
  message,
);

/**
 * Host-authoritative visibility and per-user mutation eligibility. Omitted
 * callbacks deny their corresponding operation; the UI never derives them
 * from chat roles, identity, directory visibility, or conversation type.
 */
export interface ChatWorkspaceMemberManagementAvailability {
  readonly canView: boolean;
  readonly canAddMember?: (user: HostDirectoryUserSummary) => boolean;
  readonly canRemoveMember?: (member: ConversationMemberView) => boolean;
  readonly canChangeMemberRole?: (
    member: ConversationMemberView,
    requestedRole: ConversationMemberRole,
  ) => boolean;
}

export interface MemberManagementProps {
  readonly actions: ChatActions;
  readonly availability?: ChatWorkspaceMemberManagementAvailability;
  readonly conversationId: ConversationId;
  readonly memberListRevision?: number;
  readonly members: readonly ConversationMemberView[];
  readonly membersError?: string;
  readonly membersLoading?: boolean;
  readonly readOnly?: boolean;
}

type Announcement = Readonly<{
  kind: "status" | "error";
  message: string;
}>;

const eligible = <Value,>(
  resolver: ((value: Value) => boolean) | undefined,
  value: Value,
): boolean => {
  if (resolver === undefined) return false;
  try {
    return resolver(value) === true;
  } catch {
    return false;
  }
};

const roleEligible = (
  resolver: ChatWorkspaceMemberManagementAvailability["canChangeMemberRole"],
  member: ConversationMemberView,
  requestedRole: ConversationMemberRole,
): boolean => {
  if (resolver === undefined) return false;
  try {
    return resolver(member, requestedRole) === true;
  } catch {
    return false;
  }
};

const safetyMessage = (code: "last_owner" | "last_active_member"): string =>
  code === "last_owner"
    ? "The last owner cannot be removed."
    : "The last active member cannot be removed.";

/** Canonical member list with explicitly authorized add, remove, and role controls. */
export function MemberManagement(
  props: MemberManagementProps,
): ReactElement | null {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<UserId>();
  const [pendingOperation, setPendingOperation] = useState<
    "add" | "remove" | "role" | undefined
  >();
  const [announcement, setAnnouncement] = useState<Announcement>();
  const pendingRef = useRef(false);
  const conversationGenerationRef = useRef(0);
  const latestRevisionRef = useRef(props.memberListRevision);
  latestRevisionRef.current = props.memberListRevision;
  const queryId = useId();

  const normalizedQuery = query.trim().normalize("NFC");
  const canAdd = props.readOnly !== true &&
    props.memberListRevision !== undefined &&
    props.availability?.canAddMember !== undefined;

  useEffect(() => {
    conversationGenerationRef.current += 1;
    pendingRef.current = false;
    setQuery("");
    setDebouncedQuery("");
    setSelectedUserId(undefined);
    setPendingOperation(undefined);
    setAnnouncement(undefined);
  }, [props.conversationId]);

  useEffect(() => {
    if (!canAdd || normalizedQuery.length === 0) {
      setDebouncedQuery("");
      return;
    }
    const timer = setTimeout(() => setDebouncedQuery(normalizedQuery),
      DIRECTORY_QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [canAdd, normalizedQuery]);

  const searchResult = useDirectorySearch(debouncedQuery, {
    enabled: canAdd,
    limit: 25,
  });
  const activeMemberIds = useMemo(
    () => new Set(props.members.map(({ userId }) => userId)),
    [props.members],
  );
  const searchUsers = useMemo(() => {
    const seen = new Set<UserId>();
    return (searchResult.data?.users ?? []).filter((user) => {
      if (seen.has(user.userId) || activeMemberIds.has(user.userId)) return false;
      seen.add(user.userId);
      return eligible(props.availability?.canAddMember, user);
    });
  }, [activeMemberIds, props.availability?.canAddMember, searchResult.data?.users]);
  const selectedUser = searchUsers.find(({ userId }) => userId === selectedUserId);
  const isDebouncing = normalizedQuery.length > 0 &&
    normalizedQuery !== debouncedQuery;

  const beginOperation = useCallback((
    operation: "add" | "remove" | "role",
  ): number | undefined => {
    if (pendingRef.current) return undefined;
    const revision = latestRevisionRef.current;
    if (revision === undefined) return undefined;
    pendingRef.current = true;
    setPendingOperation(operation);
    setAnnouncement(undefined);
    return revision;
  }, []);

  const finishOperation = useCallback((generation: number) => {
    if (conversationGenerationRef.current !== generation) return;
    pendingRef.current = false;
    setPendingOperation(undefined);
  }, []);

  const submitAdd = useCallback(async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (selectedUser === undefined ||
        !eligible(props.availability?.canAddMember, selectedUser)) return;
    const revision = beginOperation("add");
    if (revision === undefined) return;
    const generation = conversationGenerationRef.current;
    try {
      const result = await props.actions.addConversationMember({
        expectedMemberListRevision: revision,
        targetUserId: selectedUser.userId,
        requestedRole: "member",
      });
      if (conversationGenerationRef.current !== generation) return;
      if (result.status !== "success") {
        setAnnouncement({
          kind: "error",
          message: `${result.message} The member was not added. Try again.`,
        });
      } else if (result.value.reconciliationStatus === "member_list_conflict") {
        setAnnouncement({
          kind: "error",
          message: "The member list changed and has been refreshed. Review it and try again.",
        });
      } else {
        setQuery("");
        setDebouncedQuery("");
        setSelectedUserId(undefined);
        setAnnouncement({
          kind: "status",
          message: `${directoryUserLabel(selectedUser)} was added to the conversation.`,
        });
      }
    } catch {
      if (conversationGenerationRef.current === generation) {
        setAnnouncement({
          kind: "error",
          message: "The member could not be added. Check your connection and try again.",
        });
      }
    } finally {
      finishOperation(generation);
    }
  }, [beginOperation, finishOperation, props.actions, props.availability?.canAddMember, selectedUser]);

  const removeMember = useCallback(async (
    member: ConversationMemberView,
  ): Promise<void> => {
    if (!eligible(props.availability?.canRemoveMember, member)) return;
    const revision = beginOperation("remove");
    if (revision === undefined) return;
    const generation = conversationGenerationRef.current;
    try {
      const result = await props.actions.removeConversationMember({
        expectedMemberListRevision: revision,
        targetUserId: member.userId,
      });
      if (conversationGenerationRef.current !== generation) return;
      if (result.status !== "success") {
        setAnnouncement({
          kind: "error",
          message: `${result.message} The member was not removed. Try again.`,
        });
      } else if (result.value.reconciliationStatus === "member_list_conflict") {
        setAnnouncement({
          kind: "error",
          message: "The member list changed and has been refreshed. Review it and try again.",
        });
      } else if (result.value.reconciliationStatus === "safety_rejected") {
        setAnnouncement({
          kind: "error",
          message: safetyMessage(result.value.safetyError.code),
        });
      } else {
        setAnnouncement({
          kind: "status",
          message: `${memberLabel(member)} was removed from the conversation.`,
        });
      }
    } catch {
      if (conversationGenerationRef.current === generation) {
        setAnnouncement({
          kind: "error",
          message: "The member could not be removed. Check your connection and try again.",
        });
      }
    } finally {
      finishOperation(generation);
    }
  }, [beginOperation, finishOperation, props.actions, props.availability?.canRemoveMember]);

  const changeMemberRole = useCallback(async (
    member: ConversationMemberView,
    requestedRole: ConversationMemberRole,
  ): Promise<void> => {
    if (member.membership?.state !== "active" ||
        member.membership.role === requestedRole ||
        !roleEligible(
          props.availability?.canChangeMemberRole,
          member,
          requestedRole,
        )) return;
    const revision = beginOperation("role");
    if (revision === undefined) return;
    const generation = conversationGenerationRef.current;
    try {
      const result = await props.actions.changeConversationMemberRole({
        expectedMemberListRevision: revision,
        requestedRole,
        targetUserId: member.userId,
      });
      if (conversationGenerationRef.current !== generation) return;
      if (result.status !== "success") {
        setAnnouncement({
          kind: "error",
          message: `${result.message} The member role was not changed. Try again.`,
        });
      } else if (result.value.reconciliationStatus === "member_list_conflict") {
        setAnnouncement({
          kind: "error",
          message: "The member list changed and has been refreshed. Review it and try again.",
        });
      } else if (result.value.reconciliationStatus === "safety_rejected") {
        setAnnouncement({
          kind: "error",
          message: "The last owner cannot be assigned another role.",
        });
      } else {
        setAnnouncement({
          kind: "status",
          message: `${memberLabel(member)} is now a ${roleLabel(requestedRole)}.`,
        });
      }
    } catch {
      if (conversationGenerationRef.current === generation) {
        setAnnouncement({
          kind: "error",
          message: "The member role could not be changed. Check your connection and try again.",
        });
      }
    } finally {
      finishOperation(generation);
    }
  }, [
    beginOperation,
    finishOperation,
    props.actions,
    props.availability?.canChangeMemberRole,
  ]);

  if (props.availability?.canView !== true) return null;

  const searchContent = normalizedQuery.length === 0
    ? statusRegion("Search the directory to add a member.")
    : isDebouncing || searchResult.status === "loading"
      ? statusRegion("Searching directory…")
      : searchResult.status === "error"
        ? errorRegion(searchResult.error.message)
        : searchUsers.length === 0
          ? statusRegion("No eligible people found.")
          : createElement(
              "fieldset",
              {
                className: "handrail-chat__member-management-results",
                disabled: pendingOperation !== undefined,
              },
              createElement("legend", null, "Select one person"),
              createElement(
                "ul",
                { className: "handrail-chat__member-management-search-list" },
                ...searchUsers.map((user) => createElement(
                  "li",
                  { key: user.userId },
                  createElement(
                    "label",
                    { className: "handrail-chat__member-management-choice" },
                    createElement("input", {
                      checked: selectedUserId === user.userId,
                      name: "memberDirectoryUser",
                      onChange: () => {
                        setSelectedUserId(user.userId);
                        setAnnouncement(undefined);
                      },
                      type: "radio",
                      value: user.userId,
                    }),
                    createElement("span", null, directoryUserLabel(user)),
                  ),
                )),
              ),
            );

  return createElement(
    "section",
    {
      "aria-busy": pendingOperation === undefined ? undefined : true,
      "aria-label": "Conversation members",
      className: "handrail-chat__member-management",
    },
    createElement("h3", { className: "handrail-chat__member-management-title" }, "Members"),
    props.membersLoading === true && props.members.length === 0
      ? statusRegion("Loading members…")
      : props.membersError === undefined
        ? props.members.length === 0
          ? statusRegion("This conversation has no active members.")
          : createElement(
              "ul",
              { className: "handrail-chat__member-management-list" },
              ...props.members.map((member) => {
                const label = memberLabel(member);
                const canRemove = props.readOnly !== true &&
                  props.memberListRevision !== undefined &&
                  eligible(props.availability?.canRemoveMember, member);
                const currentRole = member.membership?.state === "active"
                  ? member.membership.role
                  : undefined;
                const roleTargets = currentRole === undefined ||
                    props.readOnly === true ||
                    props.memberListRevision === undefined
                  ? []
                  : MEMBER_ROLES.map((role) => ({
                      authorized: roleEligible(
                        props.availability?.canChangeMemberRole,
                        member,
                        role,
                      ),
                      role,
                    }));
                const canChangeRole = roleTargets.some(({ authorized, role }) =>
                  authorized && role !== currentRole);
                return createElement(
                  "li",
                  {
                    className: "handrail-chat__member-management-item",
                    key: member.userId,
                  },
                  createElement("span", null, label),
                  !canChangeRole || currentRole === undefined
                    ? null
                    : createElement(
                        "label",
                        { className: "handrail-chat__member-management-label" },
                        createElement(
                          "span",
                          { className: "handrail-chat__sr-only" },
                          `Role for ${label}`,
                        ),
                        createElement(
                          "select",
                          {
                            "aria-label": `Role for ${label}`,
                            className: "handrail-chat__member-management-role",
                            disabled: pendingOperation !== undefined,
                            name: "conversationMemberRole",
                            onChange: (event: ChangeEvent<HTMLSelectElement>) => {
                              const requestedRole = MEMBER_ROLES.find(
                                (role) => role === event.currentTarget.value,
                              );
                              if (requestedRole !== undefined) {
                                void changeMemberRole(member, requestedRole);
                              }
                            },
                            value: currentRole,
                          },
                          ...roleTargets.map(({ authorized, role }) => createElement(
                            "option",
                            {
                              disabled: !authorized,
                              key: role,
                              value: role,
                            },
                            roleLabel(role),
                          )),
                        ),
                      ),
                  !canRemove
                    ? null
                    : createElement(
                        "button",
                        {
                          "aria-label": `Remove ${label} from conversation`,
                          className: "handrail-chat__member-management-remove",
                          disabled: pendingOperation !== undefined,
                          onClick: () => void removeMember(member),
                          type: "button",
                        },
                        "Remove",
                      ),
                );
              }),
            )
        : errorRegion(props.membersError),
    !canAdd
      ? null
      : createElement(
          "form",
          {
            className: "handrail-chat__member-management-add",
            onSubmit: (event: FormEvent<HTMLFormElement>) => void submitAdd(event),
          },
          createElement(
            "label",
            {
              className: "handrail-chat__member-management-label",
              htmlFor: queryId,
            },
            "Add a member",
          ),
          createElement("input", {
            autoComplete: "off",
            className: "handrail-chat__member-management-input",
            disabled: pendingOperation !== undefined,
            id: queryId,
            name: "memberDirectoryQuery",
            onInput: (event: FormEvent<HTMLInputElement>) => {
              setQuery(event.currentTarget.value);
              setSelectedUserId(undefined);
              setAnnouncement(undefined);
            },
            type: "search",
            value: query,
          }),
          searchContent,
          createElement(
            "button",
            {
              className: "handrail-chat__member-management-submit",
              disabled: pendingOperation !== undefined || selectedUser === undefined,
              type: "submit",
            },
            "Add member",
          ),
        ),
    pendingOperation === "add"
      ? statusRegion("Adding member…")
      : pendingOperation === "remove"
        ? statusRegion("Removing member…")
        : pendingOperation === "role"
          ? statusRegion("Changing member role…")
        : null,
    announcement === undefined
      ? null
      : announcement.kind === "error"
        ? errorRegion(announcement.message)
        : statusRegion(announcement.message),
  );
}
