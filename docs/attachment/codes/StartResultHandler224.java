/*
 * Copyright © 2014-2023 上海玖行能源科技有限公司。保留所有权利。
 * 此软件受版权保护。任何未经授权的使用或复制都可能被视为侵权。
 * 未经版权所有者事先书面同意，任何人不得复制、修改、分发或使用此软件的任何部分或全部内容。
 * 如果您发现任何不当使用或侵权行为，请立即通知版权所有者。
 * 版权所有者保留所有权利。
 */

package com.enneagon.v5.server.handler.my;

import com.enneagon.v5.annotation.MessageHandlerAnnotation;
import com.enneagon.v5.constant.*;
import com.enneagon.v5.dto.TcpProxyBaseDataDto;
import com.enneagon.v5.message.BaseMessage;
import com.enneagon.v5.message.data.CM21Data;
import com.enneagon.v5.mq.UpHandler;
import com.enneagon.v5.platform.up.StartNotice;
import com.enneagon.v5.platform.up.StartResult;
import com.enneagon.v5.redis.BMSAttr;
import com.enneagon.v5.server.handler.BaseHandler;
import com.enneagon.v5.switching.service.app.SwitchingServiceTools;
import com.enneagon.v5.util.CommUtils;
import com.enneagon.v5.util.FastJsonUtils;
import com.enneagon.v5.util.RedisTool;
import com.enneagon.v5.util.TypeConversion;
import io.netty.channel.Channel;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;

/**
 * 上行-21H-启动充电结果
 * 
 * @author steve
 */
@Slf4j
@MessageHandlerAnnotation(command = CommandEnum.C21,version = {ProtocolVersion.V_224_TO_224,ProtocolVersion.V_225_TO_9999})
@Component
public class StartResultHandler224 extends BaseHandler {


	@Autowired
	private SwitchingServiceTools switchingServiceTools;
	@Autowired
	private UpHandler upHandler;
	
	@Override
	protected void handler(Channel channel, BaseMessage msg) {
		CM21Data data = (CM21Data) msg.getData();

		try {
			StartResult cm21 = new StartResult();
			StartNotice sn=new StartNotice();
			BeanUtils.copyProperties(data, cm21);
			cm21.setDeviceCode(msg.getDeviceCode());
			cm21.setCurrTime(TypeConversion.bytes2CurrTime(data.getTime()));
			cm21.setGunNo(TypeConversion.getUnsignedByte(data.getGunNo()));
			cm21.setOrderNo(TypeConversion.bytes2orderNo(data.getOrderNo()));
			cm21.setUserId(TypeConversion.bytes2userId(data.getUserId()));
			cm21.setOrgCode(TypeConversion.bytes2orgCode(data.getOrgCode()));
			cm21.setPlate(TypeConversion.bytes2plate(data.getPlate()));
			cm21.setChargingMode(TypeConversion.getUnsignedByte(data.getChargingMode()));
			BigDecimal value=new BigDecimal("0.00");
			if (data.getChargingMode() == StartConstant.ChargingMode.TIMING.getCode().intValue()) {
				value = CommUtils.round(new BigDecimal(data.getModeValue()), new BigDecimal(60), 0, 3);
			} else if (data.getChargingMode() == StartConstant.ChargingMode.ELECTRICITY.getCode().intValue()) {
				value = CommUtils.round(new BigDecimal(data.getModeValue()), new BigDecimal(CovertConst.TWO_POINT), 2, 2);
			} else if (data.getChargingMode() == StartConstant.ChargingMode.MONEY.getCode().intValue()) {
				value = CommUtils.round(new BigDecimal(data.getModeValue()), new BigDecimal(CovertConst.TWO_POINT), 2, 2);
			} else if (data.getChargingMode() == StartConstant.ChargingMode.SOC.getCode().intValue()) {
				value = new BigDecimal(data.getModeValue());
			}
			cm21.setModeValue(value);
			cm21.setModeType(TypeConversion.getUnsignedByte(data.getModeType()));
			cm21.setChargerType(TypeConversion.getUnsignedByte(data.getChargerType()));
			cm21.setRet(TypeConversion.getUnsignedByte(data.getRet()));
			cm21.setReason(data.getReason());

			if (cm21.getRet() == 1) {
				cm21.setStartDate(CommUtils.hex2ForMatDate(TypeConversion.bytes2HexString(data.getStartDate())));
				cm21.setStartElect(CommUtils.round(new BigDecimal(data.getStartElect()), new BigDecimal(CovertConst.FOUR_POINT), 4, 2));

				if(cm21.getChargerType()==2){
					/*********** 直流 ************/
					cm21.setInsDeVoltage(
							CommUtils.round(new BigDecimal(data.getInsDeVoltage()), new BigDecimal(CovertConst.ONE_POINT), 2, 2));
					cm21.setBrmVer(TypeConversion.bytes2BrmVer(data.getBrmVer()));
					cm21.setBrmBatteryType(TypeConversion.getUnsignedByte(data.getBrmBatteryType()));
					cm21.setBrmBatteryManufacturer(TypeConversion.bytes2String(data.getBrmBatteryManufacturer()));
					cm21.setBrmBatteryProdYear(TypeConversion.getUnsignedByte(data.getBrmBatteryProdYear()));
					cm21.setBrmBatteryProdMonth(TypeConversion.getUnsignedByte(data.getBrmBatteryProdMonth()));
					cm21.setBrmBatteryProdDay(TypeConversion.getUnsignedByte(data.getBrmBatteryProdDay()));
					cm21.setBrmChargingCount(
							((data.getBrmChargingCount()[0] & 0xff) | ((data.getBrmChargingCount()[1] & 0xff) << 8)
									| ((data.getBrmChargingCount()[2] & 0xff) << 16)));
					cm21.setBrmBattery(TypeConversion.getUnsignedByte(data.getBrmBattery()));
					cm21.setBrmYL(TypeConversion.getUnsignedByte(data.getBrmYL()));
					sn.setBrmVin(TypeConversion.bytes2VIN(data.getBrmVin()));
					cm21.setBrmVin(TypeConversion.bytes2VIN(data.getBrmVin()));
//					cm21.setBrmSoftVer(TypeConversion.bytes2BrmSoftVer(data.getBrmSoftVer()));
					cm21.setBcpCellAllowVoltage(
							CommUtils.round(new BigDecimal(data.getBcpCellAllowVoltage()), new BigDecimal(CovertConst.ONE_POINT), 2, 2));
					cm21.setBcpAllowCurrent(
							CommUtils.round(new BigDecimal(data.getBcpAllowCurrent()), new BigDecimal(CovertConst.ONE_POINT), 2, 2));
					cm21.setBcpBatteryCapacity(
							CommUtils.round(new BigDecimal(data.getBcpBatteryCapacity()), new BigDecimal(CovertConst.ONE_POINT), 2, 2));
					cm21.setBcpAllowVoltage(
							CommUtils.round(new BigDecimal(data.getBcpAllowVoltage()), new BigDecimal(CovertConst.ONE_POINT), 2, 2));
					cm21.setBcpAllowTemp(new BigDecimal(data.getBcpAllowTemp()).intValue());
					cm21.setBcpSoc(
							CommUtils.round(new BigDecimal(data.getBcpSoc()), new BigDecimal(CovertConst.ONE_POINT), 0, 2).shortValue());
					cm21.setBcpBatteryVoltage(
							CommUtils.round(new BigDecimal(data.getBcpBatteryVoltage()), new BigDecimal(CovertConst.ONE_POINT), 2, 2));
				}

				BMSAttr bmsAttr = new BMSAttr();
				BeanUtils.copyProperties(cm21, bmsAttr);
				String stationCode =redisTool.getStationCode(bmsAttr.getDeviceCode(), channel);
				redisTool.hset(RedisTool.BMS_ATTR_KEY + stationCode, bmsAttr.getDeviceCode() + "." + bmsAttr.getGunNo(),
						FastJsonUtils.toJSONStringUp(bmsAttr));
			}

			/*StartResult stRep = new StartResult();
			BeanUtils.copyProperties(cm21, stRep);*/
			cm21.setKey(PlatformQueueConstant.Q21_KEY);
			String gunCode=redisTool.getGunCode(null, msg.getDeviceCode(), String.valueOf(cm21.getGunNo()),channel);
			cm21.setGunCode(gunCode);
			String stationCode=redisTool.getStationCode(msg.getDeviceCode(), channel);
			String operatorCode=redisTool.getOperatorCode(stationCode,msg.getDeviceCode(), channel);
			cm21.setStationCode(stationCode);
			cm21.setOperatorCode(operatorCode);
			//FIXME 桩编码
			//convert
			String pileCode=redisTool.getPileCode(stationCode, msg.getDeviceCode(), channel);
			cm21.setPileCode(pileCode);
			
			/*ReportData rd = new ReportData();
			rd.setCommand(PlatformEnum.CQ21.getCommand());
			rd.setData(stRep);
			rd.setRecvTime(Calendar.getInstance().getTimeInMillis());
			rd.setServerName(serverName);
			rd.setDownQueue(queueDown);
			rd.setUpQueue(queueUp);
			rabbitTemplate.convertAndSend(ProQueueConfig.DATA_KEY, queueUp, FastJsonUtils.toJSONString(rd));*/
			upHandler.covertDataByCmd21(cm21);
			
			switchingServiceTools.executionDeviceRun(pileCode,
					()->rabbitTemplate.convertAndSend(PlatformChargeExchangeConstant.DATA_KEY, PlatformChargeQueueConstant.Q21_KEY,
							FastJsonUtils.toJSONStringUp(cm21)),
					()->rabbitTemplate.convertAndSend(PlatformExchangeConstant.DATA_KEY, PlatformQueueConstant.Q21_KEY,
							FastJsonUtils.toJSONStringUp(cm21)));
			log.info("0x21,数据: {}", FastJsonUtils.toJSONStringUp(cm21));
			sn.setDeviceCode(msg.getDeviceCode());
			sn.setOperatorCode(operatorCode);
			sn.setOrgCode(cm21.getOrgCode());
			sn.setGunCode(gunCode);
			sn.setOrderNo(cm21.getOrderNo());
			sn.setUserId(cm21.getUserId());
			sn.setRet(cm21.getRet());
			sn.setReason(cm21.getReason());
			sn.setStartDate(cm21.getStartDate());
			sn.setUserChargeType(cm21.getUserChargeType());
			/*rd = new ReportData();
			rd.setCommand(PlatformEnum.CQStartNotice.getCommand());
			rd.setData(sn);
			rd.setRecvTime(Calendar.getInstance().getTimeInMillis());
			rd.setServerName(serverName);
			rd.setDownQueue(queueDown);
			rd.setUpQueue(queueUp);
			rabbitTemplate.convertAndSend(ProQueueConfig.DATA_KEY, queueUp, FastJsonUtils.toJSONString(rd));*/
			rabbitTemplate.convertAndSend(PlatformExchangeConstant.EXCHANGE_QStartNotice_KEY, null, FastJsonUtils.toJSONStringUp(sn));

            sendTcpProxyQueue(TcpProxyBaseDataDto.builder()
                    .header(
                            TcpProxyBaseDataDto.Header.builder()
                                    .deviceCode(cm21.getDeviceCode())
                                    .currTime(cm21.getCurrTime())
                                    .protocolName(cm21.getProtocolName())
                                    .protocolKey(msg.getProtocolKey())
                                    .build())
                    .dataBody(cm21).build());
		} catch (Exception e) {
			log.error(e.getMessage());
		}
	}

    private void sendTcpProxyQueue(Object data) {
        try {
            //转发iot平台
            rabbitTemplate.convertAndSend(IotForwardRabbitMQConstants.EXCHANGE.CQ21H, IotForwardRabbitMQConstants.ROUTE_KEY.CQ21H, FastJsonUtils.toJSONStringUp(data));
        } catch (Exception e) {
            log.error(e.getMessage());
        }
    }
}
