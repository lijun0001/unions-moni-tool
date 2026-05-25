/**
 * 玖行桩 TCP 载荷常用标尺，与 Java `CovertConst` 对齐：
 * `ONE_POINT`=0.1，`TWO_POINT`=0.01，`FOUR_POINT`=0.0001。
 */
export const WIRE_SCALE = {
  ONE_POINT: 10,
  TWO_POINT: 100,
  FOUR_POINT: 10000,
} as const
