/** Data shapes shared by the server API and the React client. */

export type EntryKind = 'stack' | 'unique';
export type GaugeStyle = 'none' | 'bar' | 'dial';
export type DonationStatus = 'countdown' | 'pending' | 'completed' | 'cancelled' | 'rejected' | 'failed';

export interface SessionUser {
  id: string;
  username: string;
  isGm: boolean;
  roleId: string | null;
  roleName: string | null;
}

export interface RoleRef {
  id: string;
  name: string;
}

export interface ItemDefDTO {
  id: string;
  name: string;
  description: string;
  imageId: string | null;
  imageUrl: string | null;
  stackable: boolean;
  createdAt: number;
  updatedAt: number;
  /** Total units across all inventories (GM views only). */
  inUse?: number;
}

export interface EntryDTO {
  /** Entry id. For unique items this is the instance id. */
  id: string;
  itemDefId: string;
  kind: EntryKind;
  /** Display name: the instance's custom name if set, otherwise the definition name. */
  name: string;
  description: string;
  defName: string;
  customName: string | null;
  customDescription: string | null;
  imageUrl: string | null;
  quantity: number;
  /** Units held by in-flight donations. Still owned, but not available. */
  reserved: number;
  available: number;
  acquiredAt: number;
  position: number;
}

export interface CurrencyDTO {
  id: string;
  name: string;
  iconImageId: string | null;
  iconUrl: string | null;
  precision: number;
  min: string | null;
  max: string | null;
  gauge: GaugeStyle;
  color: string;
  position: number;
}

export interface BalanceDTO {
  currencyId: string;
  amount: string;
  reserved: string;
  available: string;
}

export interface InventoryDTO {
  role: RoleRef;
  entries: EntryDTO[];
  currencies: CurrencyDTO[];
  balances: BalanceDTO[];
}

export interface DonationLineDTO {
  id: string;
  assetType: 'stack' | 'unique' | 'currency';
  itemDefId: string | null;
  entryId: string | null;
  currencyId: string | null;
  name: string;
  imageUrl: string | null;
  /** Decimal string; integer for items. */
  quantity: string;
}

export interface DonationDTO {
  id: string;
  senderRoleId: string;
  senderRoleName: string;
  recipientRoleId: string;
  recipientRoleName: string;
  createdByUsername: string;
  status: DonationStatus;
  createdAt: number;
  cancelDeadline: number;
  approvalDeadline: number | null;
  resolvedAt: number | null;
  resolvedByUsername: string | null;
  resolutionNote: string | null;
  lines: DonationLineDTO[];
}

export interface PlayerStateDTO {
  serverNow: number;
  me: SessionUser;
  approvalRequired: boolean;
  /** Null when the player has no role assigned. */
  inventory: InventoryDTO | null;
  /** Usernames of everyone assigned to the player's role. */
  members: string[];
  /** Outgoing donations still in countdown or pending. */
  outgoing: DonationDTO[];
  /** Incoming donations awaiting this role's decision. */
  incoming: DonationDTO[];
  /** The role's most recently resolved donations (current state only, not the audit log). */
  recent: DonationDTO[];
}

export type DonationLineInput =
  | { type: 'item'; entryId: string; quantity: number }
  | { type: 'currency'; currencyId: string; amount: string };

export interface DonationInput {
  requestId?: string;
  recipientRoleId: string;
  lines: DonationLineInput[];
}

export interface PlayerAdminDTO {
  id: string;
  username: string;
  isGm: boolean;
  disabled: boolean;
  roleId: string | null;
  roleName: string | null;
  createdAt: number;
}

export interface RoleAdminDTO {
  id: string;
  name: string;
  createdAt: number;
  players: { id: string; username: string }[];
  entryCount: number;
  activeDonations: number;
}

export interface AuditAssetDTO {
  assetType: 'item' | 'currency';
  assetId: string;
  assetName: string;
  instanceId: string | null;
  quantity: string | null;
}

export interface AuditEventDTO {
  id: number;
  at: number;
  category: 'donation' | 'gm' | 'inventory' | 'auth' | 'system';
  action: string;
  actorUserId: string | null;
  actorUsername: string | null;
  actorIsGm: boolean;
  roleId: string | null;
  roleName: string | null;
  counterpartyRoleId: string | null;
  counterpartyRoleName: string | null;
  donationId: string | null;
  summary: string;
  details: unknown;
  assets: AuditAssetDTO[];
}

export interface OverviewDTO {
  serverNow: number;
  counts: { players: number; roles: number; itemDefinitions: number; currencies: number; activeDonations: number };
  approvalRequired: boolean;
  activeDonations: DonationDTO[];
  recentEvents: AuditEventDTO[];
  lanAddresses: string[];
}

/** Messages pushed over the WebSocket. Clients refetch state on `changed`. */
export type ServerMessage =
  | { type: 'hello'; userId: string }
  | { type: 'changed'; roles: string[]; gm: boolean; catalog?: boolean }
  | { type: 'me-changed' }
  | { type: 'notify'; kind: 'donation-pending' | 'donation-completed' | 'donation-rejected' | 'donation-cancelled' | 'donation-failed'; donationId: string; text: string; roleId: string };
