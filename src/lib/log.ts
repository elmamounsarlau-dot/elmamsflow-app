import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function logActivity(sb: SupabaseClient, userId: string, orgId: string | null, action: string, detail = '') {
  await sb.from('activity_log').insert({ org_id: orgId, user_id: userId, action, detail: detail.slice(0, 250) });
}

export const ACTIVITY_LABELS: Record<string, string> = {
  client_created: 'Client created', client_paused: 'Access paused', client_restored: 'Access restored', client_updated: 'Client details saved',
  member_invited: 'Team member invited', role_changed: 'Role adjusted', store_connected: 'Store connected', store_disconnected: 'Store disconnected', prices_saved: 'Price list saved', invoice_drafted: 'Invoice drafted', invoice_issued: 'Invoice issued', invoice_paid: 'Invoice paid', invoice_void: 'Invoice voided', billing_settings: 'Billing details saved', product_updated: 'Product edited', inbound_counted: 'Inbound counted', role_created: 'Role added', role_deleted: 'Role deleted', member_role: 'Role changed', member_removed: 'Team member removed', member_paused: 'Member paused', member_restored: 'Member restored',
  link_emailed: 'Sign-in link emailed', link_copied: 'Sign-in link created', password_set: 'Password chosen', password_changed: 'Password changed',
  product_added: 'Product added', stock_adjusted: 'Stock adjusted', inbound_created: 'Inbound announced', inbound_status: 'Inbound updated', inbound_received: 'Inbound received',
  order_created: 'Order created', order_updated: 'Order updated', order_delivered_auto: 'Delivered (carrier confirmed)', order_address_updated: 'Address updated from the store', order_address_late: 'Address changed after packing', order_cancelled: 'Order cancelled', order_held: 'Order put on hold', order_released: 'Order released', ticket_opened: 'Ticket opened', ticket_reply: 'Ticket reply',
  stock_quarantined: 'Moved to quarantine', stock_released: 'Released from quarantine', stock_written_off: 'Written off', stock_counted: 'Warehouse count applied', stock_reconciled: 'Stock reconciled', transfer_created: 'Transfer requested', transfer_dispatched: 'Transfer sent', transfer_received: 'Transfer received', transfer_cancelled: 'Transfer cancelled', order_warehouse: 'Order warehouse changed', warehouse_saved: 'Warehouse saved', warehouse_added: 'Warehouse added', warehouse_closed: 'Warehouse closed', warehouse_reopened: 'Warehouse reopened', shipment_reversed: 'Shipment reversed', products_imported: 'Products imported', quarantine_decision: 'Quarantine decision', quarantine_applied: 'Quarantine decision applied', quarantine_declined: 'Quarantine decision declined', company_profile: 'Company profile saved', order_edited: 'Order details edited', product_photo: 'Product photo changed', bundle_saved: 'Kit contents saved', orders_imported: 'Orders imported (CSV)',
  expense_added: 'Expense added', expense_edited: 'Expense edited', expense_deleted: 'Expense removed', expense_repeat_saved: 'Repeating expense changed', expense_repeat_stopped: 'Repeating expense stopped', expenses_imported: 'Bank lines imported', finance_settings: 'Finance settings saved', order_costs: 'Shipping costs recorded',
};
