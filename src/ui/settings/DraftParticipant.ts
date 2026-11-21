/**
 * Unified settings draft participant contract implemented by feature settings panels
 * and coordinated by `SettingsRoot.svelte`.
 */
export interface DraftParticipant {
  readonly id: string;
  isDirty: () => boolean;
  validate: () => void;
  save: () => Promise<void>;
  resetToDefaults: () => void;
  isReadOnly: () => boolean;
  hasConflict: () => boolean;
}

export type RegisterDraftParticipant = (participant: DraftParticipant) => () => void;
