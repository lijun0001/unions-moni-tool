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

import lombok.Data;
import lombok.EqualsAndHashCode;

/**
 * 上行-21H-启动充电结果
 * @author steve
 */
@MessageDataAnnotation(command = CommandEnum.C21)
@Data
@EqualsAndHashCode(callSuper=false)
public class CM21Data extends BaseData{

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
	
	private byte[] plate=new byte[9];
	

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
	 * 88	充电桩类型	1	HEX	1-交流；2-直流
	 */
	private byte chargerType;
	
	/**
	 *启动结果	1	HEX	1-成功；2-失败
	 */
	private byte ret;
	
	/**
	 *启动失败原因	2	HEX
	 */
	private short reason;
	
	
	/**
	 * 充电起始时间
	 */
	private byte[] startDate=new byte[6];
	
	/**
	 * 充电起始电量	4	HEX	分辨率0.01kWh
	 */
	private int startElect;
	
	/**
	 * 绝缘检测电压	2	HEX	分辨率0.1V
	 */
	private short insDeVoltage;
	
	/**
	 * DC+绝缘值	2	HEX	分辨率1Ω/V
	 */
	private short dcAddIns;
	
	/**
	 * DC-绝缘值	2	HEX	分辨率1Ω/V
	 */
	private short dcSubtractIns;
	
	/**
	 * BRM-协议版本	3
	 */
	private byte[] brmVer=new byte[3]; 
	
	/**
	 * BRM-电池类型	1	HEX
	 */
	private byte brmBatteryType;
	
	/**
	 * BRM-额定容量	2	HEX
	 */
	private short brmBatteryCapacity;
	
	/**
	 * BRM-额定总电压	2	HEX
	 */
	private short brmRatedVoltage;
	
	/**
	 * BRM-电池厂商	4	ASCII
	 */
	private byte[] brmBatteryManufacturer=new byte[4];
	
	/**
	 * BRM-电池组序号	4	-
	 */
	private int brmBatteryGroupId;
	
	/**
	 * BRM-电池生产年	1	HEX
	 */
	private byte brmBatteryProdYear;
	
	/**
	 * BRM-电池生产月	1	HEX
	 */
	private byte brmBatteryProdMonth;
	
	/**
	 * BRM-电池生产日	1	HEX
	 */
	private byte brmBatteryProdDay;
	
	/**
	 * BRM-充电次数	3	HEX
	 */
	private byte[] brmChargingCount=new byte[3];
	
	/**
	 * BRM-电池产权	1	HEX
	 */
	private byte brmBattery;
	
	/**
	 * BRM-预留	1	-
	 */
	private byte brmYL;
	
	/**
	 * BRM-VIN	17	ASCII
	 */
	private byte[] brmVin=new byte[17];
	
	/**
	 * BRM-软件版本	8	-
	 */
	private byte[] brmSoftVer=new byte[8];
	
	/**
	 * BCP-单体允许电压	2	HEX
	 */
	private short bcpCellAllowVoltage;
	
	/**
	 * BCP-最高充电电流	2	HEX
	 */
	private short bcpAllowCurrent;
	
	/**
	 * BCP-标称总容量	2	HEX
	 */
	private short bcpBatteryCapacity;
	
	/**
	 * BCP-最高充电电压	2	HEX
	 */
	private short bcpAllowVoltage;
	
	/**
	 * BCP-最高允许温度	1	HEX
	 */
	private byte bcpAllowTemp;
	
	/**
	 * BCP-SOC	2
	 */
	private short bcpSoc;
	
	/**
	 * BCP-当前电池电压	2
	 */
	private short bcpBatteryVoltage;
	
	
	
	
}
