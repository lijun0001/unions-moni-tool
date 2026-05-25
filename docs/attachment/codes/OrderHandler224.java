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
import com.enneagon.v5.message.data.CM23Data224;
import com.enneagon.v5.platform.up.Model.OrderModel;
import com.enneagon.v5.platform.up.OrderInfo;
import com.enneagon.v5.server.handler.BaseHandler;
import com.enneagon.v5.switching.service.app.SwitchingServiceTools;
import com.enneagon.v5.util.*;
import io.netty.channel.Channel;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

/**
 * 上行-23H-订单信息
 * 
 * @author steve
 */
@Slf4j
@MessageHandlerAnnotation(command = CommandEnum.C23,version = {ProtocolVersion.V_224_TO_224})
@Component
public class OrderHandler224 extends BaseHandler {

	@Autowired
	private SwitchingServiceTools switchingServiceTools;

	@Override
	protected void handler(Channel channel, BaseMessage msg) {
		CM23Data224 data = (CM23Data224) msg.getData();

		try {
			OrderInfo cm23 = new OrderInfo();
			BeanUtils.copyProperties(data, cm23);
			cm23.setDeviceCode(msg.getDeviceCode());
			cm23.setCurrTime(TypeConversion.bytes2CurrTime(data.getTime()));
			int gunNo=TypeConversion.getUnsignedByte(data.getGunNo());
//			cm23.setGunNo(TypeConversion.getUnsignedByte(data.getGunNo()));
			cm23.setOrderNo(TypeConversion.bytes2orderNo(data.getOrderNo()));
			cm23.setUserId(TypeConversion.bytes2userId(data.getUserId()));
			cm23.setOrgCode(TypeConversion.bytes2orgCode(data.getOrgCode()));
			cm23.setBalance(CommUtils.round(new BigDecimal(data.getBalance()), new BigDecimal(CovertConst.TWO_POINT), 2, 2));
			cm23.setVin(TypeConversion.bytes2VIN(data.getVin()));
			cm23.setStartDate(CommUtils.hex2ForMatDate(TypeConversion.bytes2HexString(data.getStartDate())));
			cm23.setEndDate(CommUtils.hex2ForMatDate(TypeConversion.bytes2HexString(data.getEndDate())));
			cm23.setStartElect(CommUtils.round(new BigDecimal(data.getStartElect()), new BigDecimal(CovertConst.FOUR_POINT), 4, 2));
			cm23.setEndElect(CommUtils.round(new BigDecimal(data.getEndElect()), new BigDecimal(CovertConst.FOUR_POINT), 4, 2));
			cm23.setStartSoc(TypeConversion.getUnsignedByte(data.getStartSoc()));
			cm23.setEndSoc(TypeConversion.getUnsignedByte(data.getEndSoc()));
			cm23.setChargingMode(TypeConversion.getUnsignedByte(data.getChargingMode()));
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
			cm23.setModeValue(value);
			cm23.setStartType(TypeConversion.getUnsignedByte(data.getStartType()));
			if(cm23.getStartType()==2){
				cm23.setStartUpTime(CommUtils.hex2ForMatDate(TypeConversion.bytes2HexString(data.getStartUpTime())));
			}
			cm23.setModeType(TypeConversion.getUnsignedByte(data.getModeType()));
			cm23.setRateType(TypeConversion.getUnsignedByte(data.getRateType()));
			cm23.setElectMoney(CommUtils.round(new BigDecimal(data.getElectMoney()), new BigDecimal(CovertConst.TWO_POINT), 2, 2));
			cm23.setServiceMoney(CommUtils.round(new BigDecimal(data.getServiceMoney()), new BigDecimal(CovertConst.TWO_POINT), 2, 2));
			cm23.setParkMoney(CommUtils.round(new BigDecimal(data.getParkMoney()), new BigDecimal(CovertConst.TWO_POINT), 2, 2));
			
			List<OrderModel> orders = new ArrayList<OrderModel>();
			int flag = 0;
			OrderModel orderModel = null;
			
			byte[] by1,by2;
			int rateIndex;
			BigDecimal elect;
			for (int i = 1; i <= data.getCount(); i++) {
				by1 = CommUtils.copyBytes(data.getData(), flag, 0, 1);
				by2 = CommUtils.copyBytes(data.getData(), flag+1, 0, 4);
				
				rateIndex=TypeConversion.getUnsignedByte(by1[0]);
				elect=CommUtils.round(new BigDecimal(TypeConversion.bytes2intLe(by2)), new BigDecimal(CovertConst.FOUR_POINT), 4, 2);
				orderModel=new OrderModel(rateIndex, elect);
				orders.add(orderModel);
				flag = flag + 5;
			}
			cm23.setOrders(orders);
			cm23.setSnCode(TypeCovertUtils.bytes2SnCode(data.getSnCode()));

			/*OrderInfo orderInfo = new OrderInfo();
			BeanUtils.copyProperties(cm23, orderInfo);*/
			String gunCode=redisTool.getGunCode(null, msg.getDeviceCode(), String.valueOf(gunNo),channel);
			cm23.setGunCode(gunCode);
			String stationCode=redisTool.getStationCode(msg.getDeviceCode(), channel);
			cm23.setStationCode(stationCode);
			cm23.setOperatorCode(redisTool.getOperatorCode(stationCode,msg.getDeviceCode(), channel));
			//FIXME 桩编码
			//convert
			String pileCode=redisTool.getPileCode(stationCode, msg.getDeviceCode(), channel);
			cm23.setPileCode(pileCode);
			
			/*ReportData rd = new ReportData();
			rd.setCommand(PlatformEnum.CQ23.getCommand());
			rd.setData(orderInfo);
			rd.setRecvTime(Calendar.getInstance().getTimeInMillis());
			rd.setServerName(serverName);
			rd.setDownQueue(queueDown);
			rd.setUpQueue(queueUp);
			rabbitTemplate.convertAndSend(ProQueueConfig.DATA_KEY, queueUp, FastJsonUtils.toJSONString(rd));*/
			
			switchingServiceTools.executionDeviceRun(pileCode,
					()->rabbitTemplate.convertAndSend(PlatformChargeExchangeConstant.DATA_KEY, PlatformChargeQueueConstant.Q23_KEY,
							FastJsonUtils.toJSONStringUp(cm23)),
					()->rabbitTemplate.convertAndSend(PlatformExchangeConstant.DATA_KEY, PlatformQueueConstant.Q23_KEY,
							FastJsonUtils.toJSONStringUp(cm23)));
			log.info("0x23,数据: {}", FastJsonUtils.toJSONStringUp(cm23));
			redisTool.hdel(RedisTool.BMS_ATTR_KEY + stationCode, msg.getDeviceCode() + "." + gunNo);
            sendTcpProxyQueue(TcpProxyBaseDataDto.builder()
                    .header(
                            TcpProxyBaseDataDto.Header.builder()
                                    .deviceCode(cm23.getDeviceCode())
                                    .currTime(cm23.getCurrTime())
                                    .protocolName(cm23.getProtocolName())
                                    .protocolKey(msg.getProtocolKey())
                                    .build())
                    .dataBody(cm23).build());
		} catch (Exception e) {
			log.error(e.getMessage());
		}
	}

    private void sendTcpProxyQueue(Object data) {
        try {
            //转发iot平台
            rabbitTemplate.convertAndSend(IotForwardRabbitMQConstants.EXCHANGE.CQ23H, IotForwardRabbitMQConstants.ROUTE_KEY.CQ23H, FastJsonUtils.toJSONStringUp(data));
        } catch (Exception e) {
            log.error(e.getMessage());
        }
    }
}
