/*
 * Copyright © 2014-2023 上海玖行能源科技有限公司。保留所有权利。
 * 此软件受版权保护。任何未经授权的使用或复制都可能被视为侵权。
 * 未经版权所有者事先书面同意，任何人不得复制、修改、分发或使用此软件的任何部分或全部内容。
 * 如果您发现任何不当使用或侵权行为，请立即通知版权所有者。
 * 版权所有者保留所有权利。
 */

package com.enneagon.v5.message.data;

import com.enneagon.v5.message.BaseData;
import com.enneagon.v5.annotation.MessageDataAnnotation;
import com.enneagon.v5.constant.CommandEnum;
import com.enneagon.v5.constant.ProtocolVersion;

import lombok.Data;
import lombok.EqualsAndHashCode;

/**
 * 上行-20H-回复启动充电
 * @author steve
 */
@MessageDataAnnotation(command = CommandEnum.C20,version = {ProtocolVersion.V_218_TO_218,ProtocolVersion.V_219_TO_221,ProtocolVersion.V_222_TO_222,ProtocolVersion.V_223_TO_223,ProtocolVersion.V_224_TO_224,ProtocolVersion.V_225_TO_9999})
@Data
@EqualsAndHashCode(callSuper=false)
public class CM20Data218 extends BaseData{

	/**
	 * 时标
	 */
	private byte[] time=new byte[6];
	
	private byte gunNo;
	
	private byte[] orderNo=new byte[32];
	
	private byte[] userId=new byte[32];
	
	/**
	 * 用户类型	2	HEX	表1.8
	 */
	private short userChargeType;
	
	/**
	 * 组织机构代码	9	ASCII
	 */
	private byte[] orgCode=new byte[9];
	
	/**
	 * 控制方式	1	HEX	
	 * 1-	定时长充
	 * 2-	定电量充
	 * 3-	定金额充
	 * 4-	自动充满
	 */
	private byte chargingMode;
	
	/**
	 * 控制参数	4	HEX	
	 * 定时长充-1秒/bit；
	 * 定金额充-0.01元/bit；
	 * 定电量充-0.01kWh
	 */
	private int modeValue;
	
	/**
	 * 充电模式	1	HEX	
	 * 1-	普通
	 * 2-	轮充
	 * 3-	大功率
	 * 4-	超级充
	 * 5-	电池维护
	 * 6-	柔性充
	 */
	private byte modeType;
	
	/**
	 * 启动方式	1	HEX	
	 * 1-立即启动；
	 * 2-定时启动
	 */
	private byte startType;
	
	/**
	 * 定时启动时间
	 */
	private byte[] startDate=new byte[6];
	
	/**
	 * 用户操作码	6	ASCII	数字，用于停止充电
	 */
	private byte[] ocCode=new byte[6];
	
	/**
	 * 计费模型选择	1	HEX	
	 * 1-	使用本地计费模型
	 * 2-	本报文所供计费模型
	 */
	private byte rateType;
	
	/**
	 *执行结果	1	HEX	1-成功；2-失败
	 */
	private byte ret;
	
	/**
	 *失败原因	1	HEX	
	 *1-	设备故障
	 *2-	充电枪使用中
	 *3-	与预约用户不一致
	 *4-	定时失败
	 *5-	参数不支持6-	其它
	 */
	private byte reason;
	
}
