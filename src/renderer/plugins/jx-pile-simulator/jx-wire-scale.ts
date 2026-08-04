/**
 * 玖行桩 TCP 载荷常用标尺，与 Java `CovertConst` 对齐：
 * `ONE_POINT`=0.1，`TWO_POINT`=0.01，`THREE_POINT`=0.001，`FOUR_POINT`=0.0001。
 * 电能费用 / 服务费用 / 充电金额 / 段电费服务费（0x23、0x25、0x33）使用 `TWO_POINT`（0.01 元）；
 * 电量、电价/服务费单价使用 `FOUR_POINT`；账户余额使用 `TWO_POINT`。
 */
export const WIRE_SCALE = {
  ONE_POINT: 10,
  TWO_POINT: 100,
  THREE_POINT: 1000,
  FOUR_POINT: 10000,
} as const
