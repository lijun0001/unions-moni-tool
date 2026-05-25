import type { CecProtocolMapping } from './cec-types'

export const CEC_DEFAULT_PROTOCOL: CecProtocolMapping = {
  protocolId: 'cec-union-v1',
  protocolName: '中电联-标准交换',
  version: '1.0.0',
  endpoints: {
    query_stations_info: { path: '/query_stations_info', method: 'POST' },
    notification_stationStatus: { path: '/notification_stationStatus', method: 'POST' },
    query_station_status: { path: '/query_station_status', method: 'POST' },
    query_station_stats: { path: '/query_station_stats', method: 'POST' },
    query_equip_auth: { path: '/query_equip_auth', method: 'POST' },
    query_equip_business_policy: { path: '/query_equip_business_policy', method: 'POST' },
    query_start_charge: { path: '/query_start_charge', method: 'POST' },
    notification_start_charge_result: { path: '/notification_start_charge_result', method: 'POST' },
    query_equip_charge_status: { path: '/query_equip_charge_status', method: 'POST' },
    notification_equip_charge_status: { path: '/notification_equip_charge_status', method: 'POST' },
    query_stop_charge: { path: '/query_stop_charge', method: 'POST' },
    notification_stop_charge_result: { path: '/notification_stop_charge_result', method: 'POST' },
    notification_charge_order_info: { path: '/notification_charge_order_info', method: 'POST' },
    check_charge_orders: { path: '/check_charge_orders', method: 'POST' },
    query_token: { path: '/query_token', method: 'POST' },
  },
  envelope: {
    operatorIdField: 'OperatorID',
    dataField: 'Data',
    encryptData: true,
  },
}
