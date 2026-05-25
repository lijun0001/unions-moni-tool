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

import java.lang.reflect.Field;
import java.lang.reflect.Method;


/**
 * 上行-25H-充电信息
 * @author steve
 */
@MessageDataAnnotation(command = CommandEnum.C25,version = {ProtocolVersion.V_222_TO_222,ProtocolVersion.V_223_TO_223,ProtocolVersion.V_224_TO_224,ProtocolVersion.V_225_TO_9999})
@Data
@EqualsAndHashCode(callSuper=false)
public class CM25Data222 extends BaseData{

	/**
	 * 时标
	 */
	private byte[] time=new byte[6];
	
	private byte gunNo;
	
	/**
	 * 充电电压	2	HEX	分辨率0.1V
	 */
	private short chargerVoltage;
	/**
	 * 充电电流	2	HEX	分辨率0.1A
	 */
	private short chargerCurrent;
	
	/**
	 * 充电电量	4	HEX	分辨率0.01kWh
	 */
	private int elect;
	/**
	 * 充电时长	4	HEX	分辨率1s
	 */
	private int chargerDuration;
	/**
	 * 充电金额	4	HEX	分辨率0.01元
	 */
	private int money;
	/**
	 * 充电模块接入数量	1
	 */
	private byte modelCount;
	
	/**
	 * 充电电费金额	4	HEX	分辨率0.01元
	 */
	private int elecMoney;
	
	/**
	 * 充电服务费金额	4	HEX	分辨率0.01元
	 */
	private int seviceMoney;
	
	private byte[] orderNo=new byte[32];

    /**
     * 账户余额	4	HEX	分辨率0.01元
     */
    private int balance;
	
	/**
     * 时间段数量N	1
     */
    private byte count;


    /**
     * 段1开始时间	6	时间格式
     * 段1结束时间	6	时间格式
     * 段1电价	4	HEX	分辨率0.0001
     * 段1服务费价格	4	HEX	分辨率0.0001
     * 段1电量	4	HEX	0.01kWh
     * 段1电费	4	HEX	分辨率0.01元
     * 段1服务费	4	HEX	分辨率0.01元
     */
    private byte[] data = new byte[32];

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
            e.printStackTrace();
        }
    }

}
