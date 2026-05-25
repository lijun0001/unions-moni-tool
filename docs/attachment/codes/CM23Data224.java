/*
 * Copyright © 2014-2023 上海玖行能源科技有限公司。保留所有权利。
 * 此软件受版权保护。任何未经授权的使用或复制都可能被视为侵权。
 * 未经版权所有者事先书面同意，任何人不得复制、修改、分发或使用此软件的任何部分或全部内容。
 * 如果您发现任何不当使用或侵权行为，请立即通知版权所有者。
 * 版权所有者保留所有权利。
 */

package com.enneagon.v5.message.data;

import com.enneagon.v5.annotation.MessageDataAnnotation;
import com.enneagon.v5.constant.CommandEnum;
import com.enneagon.v5.constant.ProtocolVersion;
import com.enneagon.v5.message.BaseData;
import lombok.Data;
import lombok.EqualsAndHashCode;
import lombok.extern.slf4j.Slf4j;

import java.lang.reflect.Field;
import java.lang.reflect.Method;

@Slf4j
@MessageDataAnnotation(command = CommandEnum.C23,version = {ProtocolVersion.V_224_TO_224})
@Data
@EqualsAndHashCode(callSuper=false)
public class CM23Data224 extends BaseData{

	/**
	 * 时标
	 */
	private byte[] time=new byte[6];
	
	private byte gunNo;
	
	/**
	 * 记录索引号	4	HEX
	 */
	private int recordIndex;
	
	
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
	 * 卡余额	4	HEX	分辨率0.01元
	 */
	private int balance;
	
	private byte[] vin=new byte[17];
	
	/**
	 * 开始充电时间	6
	 */
	private byte[] startDate=new byte[6];
	
	/**
	 * 结束充电时间	6
	 */
	private byte[] endDate=new byte[6];
	
	/**
	 * 开始充电电量	4	HEX	小端无符号；分辨率 0.0001kWh（平台 OrderHandler224 使用 CovertConst.FOUR_POINT 解析）
	 */
	private int startElect;
	
	/**
	 * 结束充电电量	4	HEX	小端无符号；分辨率 0.0001kWh
	 */
	private int endElect;
	
	/**
	 * 开始充电SOC	1	HEX
	 */
	private byte startSoc;
	
	/**
	 * 结束充电SOC	1	HEX
	 */
	private byte endSoc;
	
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
	 * 启动类型	1	HEX	
	 * 1-	立即启动
	 * 2-	定时启动
	 */
	private byte startType;
	
	/**
	 * 定时启动时间	6	时间格式	仅“启动类型”为2时有效
	 */
	private byte[] startUpTime=new byte[6];
	
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
	 * 停止充电原因	2	HEX
	 */
	private short stopReason;
	
	/**
	 * 计费模型选择	1	HEX	
	 * 1-使用本地计费模型
	 * 2-卡计费模型
	 */
	private byte rateType;
	
	/**
	 * 计费模型版本	4	HEX
	 */
	private int rateVersion;
	
	/**
	 * 电能费用	4	HEX
	 */
	private int electMoney;
	
	/**
	 * 服务费费用	4	HEX
	 */
	private int serviceMoney;
	
	/**
	 * 停车费费用	4	HEX
	 */
	private int parkMoney;
	
	/**
	 * 时间段数量N	1	HEX	1-20
	 */
	private byte count;
	
	/**
	 * 段1计费模型索引	1	HEX	0-11
	 * 段1电量	4	HEX	小端无符号；分辨率 0.0001kWh（每段共 5 字节，循环 N 段）
	 */
	private byte[] data=new byte[5];
	
	/**
	 * 电池sn 27 ASCII (缺省为 0xFF)
	 */
	private byte[] snCode=new byte[27];
	
	@Override
	public void fromBytes(byte[] bytes) throws Exception {
		try {
            Field[] fields = this.getClass().getDeclaredFields();
            Method[] methods = this.getClass().getMethods();

            int i = 0;
            for (Field field: fields) {
                Method method = BaseData.getSetMethodFromField(methods, field.getName());
                if(null == method) {
                    continue;
                }
                String typeName = field.getType().getSimpleName();
                int size = BaseData.getSizeFromTypeName(typeName);

                if(size != -1) {
                    byte[] valBytes = new byte[size];
                    System.arraycopy(bytes, i, valBytes, 0, size);
                    method.invoke(this, BaseData.getValFromTypeName(typeName, valBytes));
                } else if(field.getType().isArray()){
                    Method getMethod = BaseData.getGetMethodFromField(methods, field.getName());
                    byte[] getValBytes = (byte[])getMethod.invoke(this);
                    if(field.getName().equals("data")){
                    	getValBytes = new byte[this.getCount()*getValBytes.length];
                    }
                    size = getValBytes.length;
                    byte[] valBytes = new byte[size];
                    System.arraycopy(bytes, i, valBytes, 0, size);
                    method.invoke(this, valBytes);
                } else {
                    throw new Exception("类型不支持");
                }
                i+=size;
                if(i==bytes.length) {
                	break;
                }
            }

        } catch (Exception e) {
        	log.error("{}",e);
        }
	}
}
