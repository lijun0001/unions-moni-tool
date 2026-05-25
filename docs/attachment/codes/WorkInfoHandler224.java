/*
 * Copyright © 2014-2023 上海玖行能源科技有限公司。保留所有权利。
 * 此软件受版权保护。任何未经授权的使用或复制都可能被视为侵权。
 * 未经版权所有者事先书面同意，任何人不得复制、修改、分发或使用此软件的任何部分或全部内容。
 * 如果您发现任何不当使用或侵权行为，请立即通知版权所有者。
 * 版权所有者保留所有权利。
 */

package com.enneagon.v5.server.handler.my;

import com.enneagon.v5.annotation.MessageHandlerAnnotation;
import com.enneagon.v5.config.FeatureToggleConfig;
import com.enneagon.v5.constant.*;
import com.enneagon.v5.dto.TcpProxyBaseDataDto;
import com.enneagon.v5.message.BaseMessage;
import com.enneagon.v5.message.data.CM25Data222;
import com.enneagon.v5.mq.UpHandler;
import com.enneagon.v5.platform.up.Model.ElectDetailModel;
import com.enneagon.v5.platform.up.WorkInfo;
import com.enneagon.v5.server.handler.BaseHandler;
import com.enneagon.v5.util.CommUtils;
import com.enneagon.v5.util.FastJsonUtils;
import com.enneagon.v5.util.TypeConversion;
import io.netty.channel.Channel;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;

/**
 * 上行-25H-充电信息
 * 
 * @author steve
 */
@Slf4j
@MessageHandlerAnnotation(command = CommandEnum.C25,version = {ProtocolVersion.V_224_TO_224,ProtocolVersion.V_225_TO_9999})
@Component
public class WorkInfoHandler224 extends BaseHandler{

	
	@Autowired
	private UpHandler upHandler;
	@Autowired
	private FeatureToggleConfig featureToggleConfig;
	@Override
	protected void handler(Channel channel, BaseMessage msg) {
		CM25Data222 data = (CM25Data222) msg.getData();
		
		try {
			WorkInfo cm25=new WorkInfo();
			cm25.setDeviceCode(msg.getDeviceCode());
			cm25.setCurrTime(TypeConversion.bytes2CurrTime(data.getTime()));
			int gunNo=TypeConversion.getUnsignedByte(data.getGunNo());
//			cm25.setGunNo(TypeConversion.getUnsignedByte(data.getGunNo()));
			cm25.setChargerVoltage(CommUtils.round(new BigDecimal(data.getChargerVoltage()), new BigDecimal(CovertConst.ONE_POINT), 2, 2));
			cm25.setChargerCurrent(CommUtils.round(new BigDecimal(data.getChargerCurrent()), new BigDecimal(CovertConst.ONE_POINT), 2, 2));
			cm25.setElect(CommUtils.round(new BigDecimal(data.getElect()), new BigDecimal(CovertConst.FOUR_POINT), 4, 2));
			cm25.setChargerDuration(CommUtils.round(new BigDecimal(data.getChargerDuration()), new BigDecimal(60), 0, 3).intValue());
			cm25.setMoney(CommUtils.round(new BigDecimal(data.getMoney()), new BigDecimal(CovertConst.TWO_POINT), 2, 2));
			cm25.setModelCount(TypeConversion.getUnsignedByte(data.getModelCount()));
			cm25.setElecMoney(CommUtils.round(new BigDecimal(data.getElecMoney()), new BigDecimal(CovertConst.TWO_POINT), 2, 2));
			cm25.setSeviceMoney(CommUtils.round(new BigDecimal(data.getSeviceMoney()), new BigDecimal(CovertConst.TWO_POINT), 2, 2));
			cm25.setBalance(CommUtils.round(new BigDecimal(data.getBalance()), new BigDecimal(CovertConst.TWO_POINT), 2, 2));
			cm25.setOrderNo(TypeConversion.bytes2orderNo(data.getOrderNo()));
			
			if (data.getCount() > 0){
				List<ElectDetailModel> models = new ArrayList<>();
				int flag = 0;
				ElectDetailModel electDetailModel = null;
				byte[] by1,by2,by3,by4,by5,by6,by7;


				String startDate,endDate;
				BigDecimal electFee, seviceFee, elect, electMoney, seviceMoney;


				for (int i = 1; i <= data.getCount(); i++) {
					by1 = CommUtils.copyBytes(data.getData(), flag, 0, 6);
					by2 = CommUtils.copyBytes(data.getData(), flag+6, 0, 6);
					by3 = CommUtils.copyBytes(data.getData(), flag+12, 0, 4);
					by4 = CommUtils.copyBytes(data.getData(), flag+16, 0, 4);
					by5 = CommUtils.copyBytes(data.getData(), flag+20, 0, 4);
					by6 = CommUtils.copyBytes(data.getData(), flag+24, 0, 4);
					by7 = CommUtils.copyBytes(data.getData(), flag+28, 0, 4);


					startDate = CommUtils.hex2ForMatDate(TypeConversion.bytes2HexString(by1));
					endDate =  CommUtils.hex2ForMatDate(TypeConversion.bytes2HexString(by2));

					electFee=CommUtils.round(new BigDecimal(TypeConversion.bytes2intLe(by3)), new BigDecimal(CovertConst.FOUR_POINT), 4, 2);
					seviceFee=CommUtils.round(new BigDecimal(TypeConversion.bytes2intLe(by4)), new BigDecimal(CovertConst.FOUR_POINT), 4, 2);
					elect=CommUtils.round(new BigDecimal(TypeConversion.bytes2intLe(by5)), new BigDecimal(CovertConst.FOUR_POINT), 4, 2);
					electMoney=CommUtils.round(new BigDecimal(TypeConversion.bytes2intLe(by6)), new BigDecimal(CovertConst.TWO_POINT), 2, 2);
					seviceMoney=CommUtils.round(new BigDecimal(TypeConversion.bytes2intLe(by7)), new BigDecimal(CovertConst.TWO_POINT), 2, 2);


					electDetailModel = new ElectDetailModel(startDate, endDate, electFee, seviceFee, elect, electMoney, seviceMoney);
					models.add(electDetailModel);
					flag = flag + 32;
				}
				cm25.setModeles(models);

			}

			
			/*WorkInfo workInnfo=new WorkInfo();
			BeanUtils.copyProperties(cm25, workInnfo);*/
			String gunCode=redisTool.getGunCode(null, msg.getDeviceCode(), String.valueOf(gunNo),channel);
			cm25.setGunCode(gunCode);
			String stationCode=redisTool.getStationCode(msg.getDeviceCode(), channel);
			cm25.setStationCode(stationCode);
			cm25.setOperatorCode(redisTool.getOperatorCode(stationCode,msg.getDeviceCode(), channel));
			//convert
			String pileCode=redisTool.getPileCode(null, msg.getDeviceCode(), channel);
			cm25.setPileCode(pileCode);
			if (featureToggleConfig.isSetCurrTimeEnabled()) {
				cm25.setCurrTime(LocalDateTime.now().toInstant(ZoneOffset.of("+8")).toEpochMilli());
			}

			/*ReportData rd = new ReportData();
			rd.setCommand(PlatformEnum.CQ25.getCommand());
			rd.setData(workInnfo);
			rd.setRecvTime(Calendar.getInstance().getTimeInMillis());
			rd.setServerName(serverName);
			rd.setDownQueue(queueDown);
			rd.setUpQueue(queueUp);
			rabbitTemplate.convertAndSend(ProQueueConfig.DATA_KEY, queueUp, FastJsonUtils.toJSONString(rd));*/
			
			upHandler.covertDataByCmd25(cm25);
			rabbitTemplate.convertAndSend(PlatformExchangeConstant.DATA_KEY, PlatformQueueConstant.Q25_KEY, FastJsonUtils.toJSONStringUp(cm25));
			log.info("0x25,数据: {}", FastJsonUtils.toJSONStringUp(cm25));
            sendTcpProxyQueue(TcpProxyBaseDataDto.builder()
                    .header(
                            TcpProxyBaseDataDto.Header.builder()
                                    .deviceCode(cm25.getDeviceCode())
                                    .currTime(cm25.getCurrTime())
                                    .protocolName(cm25.getProtocolName())
                                    .protocolKey(msg.getProtocolKey())
                                    .build())
                    .dataBody(cm25).build());
		} catch (Exception e) {
			log.error("0x25,{}",e);
		}
	}

    private void sendTcpProxyQueue(Object data) {
        try {
            String message = FastJsonUtils.toJSONStringUp(data);
            //转发iot平台
            rabbitTemplate.convertAndSend(IotForwardRabbitMQConstants.EXCHANGE.CQ25H, IotForwardRabbitMQConstants.ROUTE_KEY.CQ25H, message);
        } catch (Exception e) {
            log.error(e.getMessage());
        }
    }
}
