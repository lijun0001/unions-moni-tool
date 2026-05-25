/*
 * Copyright © 2014-2023 上海玖行能源科技有限公司。保留所有权利。
 * 此软件受版权保护。任何未经授权的使用或复制都可能被视为侵权。
 * 未经版权所有者事先书面同意，任何人不得复制、修改、分发或使用此软件的任何部分或全部内容。
 * 如果您发现任何不当使用或侵权行为，请立即通知版权所有者。
 * 版权所有者保留所有权利。
 */

package com.enneagon.v5.server.handler.my;

import java.math.BigDecimal;

import com.enneagon.v5.constant.*;
import com.enneagon.v5.dto.TcpProxyBaseDataDto;
import com.enneagon.v5.message.data.CM20Data218;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import com.enneagon.v5.annotation.MessageHandlerAnnotation;
import com.enneagon.v5.message.BaseMessage;
import com.enneagon.v5.mq.UpHandler;
import com.enneagon.v5.platform.up.StartNotice;
import com.enneagon.v5.platform.up.StartResult;
import com.enneagon.v5.server.handler.BaseHandler;
import com.enneagon.v5.util.CommUtils;
import com.enneagon.v5.util.FastJsonUtils;
import com.enneagon.v5.util.RedisTool;
import com.enneagon.v5.util.TypeConversion;

import io.netty.channel.Channel;
import lombok.extern.slf4j.Slf4j;

/**
 * 上行-20H-回复启动充电
 * 
 * @author steve
 */
@Slf4j
@MessageHandlerAnnotation(command = CommandEnum.C20,version = {ProtocolVersion.V_218_TO_218,ProtocolVersion.V_219_TO_221,ProtocolVersion.V_222_TO_222,ProtocolVersion.V_223_TO_223,ProtocolVersion.V_224_TO_224,ProtocolVersion.V_225_TO_9999})
@Component
public class StartRespHandler218 extends BaseHandler {

	
	@Autowired
	private UpHandler upHandler;
	
	@Override
	protected void handler(Channel channel, BaseMessage msg) {
		try {
            CM20Data218 data = (CM20Data218) msg.getData();
			StartResult cm20 = new StartResult();
			BeanUtils.copyProperties(data, cm20);
			cm20.setDeviceCode(msg.getDeviceCode());
			cm20.setCurrTime(TypeConversion.bytes2CurrTime(data.getTime()));
			int gunNo=TypeConversion.getUnsignedByte(data.getGunNo());
//			cm20.setGunNo(TypeConversion.getUnsignedByte(data.getGunNo()));
			cm20.setOrderNo(TypeConversion.bytes2orderNo(data.getOrderNo()));
			cm20.setUserId(TypeConversion.bytes2userId(data.getUserId()));
			cm20.setOrgCode(TypeConversion.bytes2orgCode(data.getOrgCode()));
			cm20.setChargingMode(TypeConversion.getUnsignedByte(data.getChargingMode()));
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
			cm20.setModeValue(value);
			cm20.setModeType(TypeConversion.getUnsignedByte(data.getModeType()));
			cm20.setStartType(TypeConversion.getUnsignedByte(data.getStartType()));
			cm20.setStartDate(CommUtils.hex2ForMatDate(TypeConversion.bytes2HexString(data.getStartDate())));
			cm20.setOcCode(TypeConversion.bytes2String(data.getOcCode()));
			cm20.setRateType(TypeConversion.getUnsignedByte(data.getRateType()));
			cm20.setRet(TypeConversion.getUnsignedByte(data.getRet()));
		    cm20.setReason(TypeConversion.getUnsignedByte(data.getReason()));
			
		    redisTool.hset(RedisTool.RETRY_START_KEY + cm20.getDeviceCode()+gunNo, cm20.getDeviceCode()+gunNo,gunNo+"");
		    
		    String gunCode=redisTool.getGunCode(null, msg.getDeviceCode(), String.valueOf(gunNo),channel);
		   /* StartResp stRep=new StartResp();
		    BeanUtils.copyProperties(cm20, stRep);
		    stRep.setGunCode(gunCode);
		    //FIXME 桩编码
		    stRep.setPileCode(msg.getDeviceCode());
		    ReportData rd = new ReportData();
			rd.setCommand(PlatformEnum.CQ20.getCommand());
			rd.setData(stRep);
			rd.setRecvTime(Calendar.getInstance().getTimeInMillis());
			rd.setServerName(serverName);
			rd.setDownQueue(queueDown);
			rd.setUpQueue(queueUp);
			rabbitTemplate.convertAndSend(ProQueueConfig.DATA_KEY, queueUp, FastJsonUtils.toJSONString(rd));*/
			
			if(cm20.getRet()==2){
				/*StartResult stRep1 = new StartResult();
				BeanUtils.copyProperties(cm20, stRep1);*/
				cm20.setKey(PlatformQueueConstant.Q20_KEY);
				cm20.setGunCode(gunCode);
				String stationCode=redisTool.getStationCode(msg.getDeviceCode(), channel);
				cm20.setStationCode(stationCode);
				String operatorCode=redisTool.getOperatorCode(stationCode,msg.getDeviceCode(), channel);
				cm20.setOperatorCode(operatorCode);
				//FIXME 桩编码
				//convert
				String pileCode=redisTool.getPileCode(stationCode, msg.getDeviceCode(), channel);
				cm20.setPileCode(pileCode);
				
				/*ReportData rd1 = new ReportData();
				rd1.setCommand(PlatformEnum.CQ21.getCommand());
				rd1.setData(stRep1);
				rd1.setRecvTime(Calendar.getInstance().getTimeInMillis());
				rd1.setServerName(serverName);
				rd1.setDownQueue(queueDown);
				rd1.setUpQueue(queueUp);
				rabbitTemplate.convertAndSend(ProQueueConfig.DATA_KEY, queueUp, FastJsonUtils.toJSONString(rd1));*/
				upHandler.covertDataByCmd21(cm20);
				rabbitTemplate.convertAndSend(PlatformExchangeConstant.DATA_KEY, PlatformQueueConstant.Q21_KEY, FastJsonUtils.toJSONStringUp(cm20));
				log.info("0x21,数据: {}", FastJsonUtils.toJSONStringUp(cm20));
				StartNotice sn=new StartNotice();
				sn.setDeviceCode(msg.getDeviceCode());
				sn.setOperatorCode(operatorCode);
				sn.setOrgCode(cm20.getOrgCode());
				sn.setGunCode(gunCode);
				sn.setOrderNo(cm20.getOrderNo());
				sn.setUserId(cm20.getUserId());
				sn.setRet(cm20.getRet());
				sn.setReason(cm20.getReason());
				sn.setStartDate(cm20.getStartDate());
				/*ReportData rd = new ReportData();
				rd.setCommand(PlatformEnum.CQStartNotice.getCommand());
				rd.setData(sn);
				rd.setRecvTime(Calendar.getInstance().getTimeInMillis());
				rd.setServerName(serverName);
				rd.setDownQueue(queueDown);
				rd.setUpQueue(queueUp);
				rabbitTemplate.convertAndSend(ProQueueConfig.DATA_KEY, queueUp, FastJsonUtils.toJSONString(rd));*/
				rabbitTemplate.convertAndSend(PlatformExchangeConstant.EXCHANGE_QStartNotice_KEY, null, FastJsonUtils.toJSONStringUp(sn));
			}
            sendTcpProxyQueue(TcpProxyBaseDataDto.builder()
                    .header(
                            TcpProxyBaseDataDto.Header.builder()
                                    .deviceCode(cm20.getDeviceCode())
                                    .currTime(cm20.getCurrTime())
                                    .protocolName(cm20.getProtocolName())
                                    .protocolKey(msg.getProtocolKey())
                                    .build())
                    .dataBody(cm20).build());
		}catch (Exception e) {
            log.error("0x20,Handler error:{},{}", e.getMessage(), e);
		}
	}

    private void sendTcpProxyQueue(Object data) {
        try {
            //转发iot平台
            rabbitTemplate.convertAndSend(IotForwardRabbitMQConstants.EXCHANGE.CQ20H, IotForwardRabbitMQConstants.ROUTE_KEY.CQ20H, FastJsonUtils.toJSONStringUp(data));
        } catch (Exception e) {
            log.error(e.getMessage());
        }
    }
}
