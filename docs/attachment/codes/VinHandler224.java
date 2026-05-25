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
import com.enneagon.v5.message.data.CM40Data224;
import com.enneagon.v5.mq.UpHandler;
import com.enneagon.v5.platform.up.VerifyVin;
import com.enneagon.v5.server.handler.BaseHandler;
import com.enneagon.v5.util.FastJsonUtils;
import com.enneagon.v5.util.TypeConversion;
import io.netty.channel.Channel;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang3.StringUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import javax.annotation.Resource;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/**
 * 上行-40H-VIN鉴权
 *
 * @author steve
 */
@Slf4j
@MessageHandlerAnnotation(command = CommandEnum.C40,version = {ProtocolVersion.V_224_TO_224,ProtocolVersion.V_225_TO_9999})
@Component
public class VinHandler224 extends BaseHandler {

    private static final String Q5B_MESSAGE_FAIL = "Q5B_MESSAGE_FAIL:";

    private static final String Q40_MESSAGE = "Q40_MESSAGE:";

    /**
     * 40报文订单记录过期时间 1h
     */
    private final static Long ORDER_EXPIRATION_TIME = 60 * 60L;


    @Autowired
    private UpHandler upHandler;

    @Resource
    private StringRedisTemplate stringRedisTemplate;

    @Override
    protected void handler(Channel channel, BaseMessage msg) {
        CM40Data224 data = (CM40Data224) msg.getData();

        try {
            VerifyVin cm40 = new VerifyVin();
            cm40.setDeviceCode(msg.getDeviceCode());
            cm40.setCurrTime(TypeConversion.bytes2CurrTime(data.getTime()));
            String vin = new String(data.getVin(), StandardCharsets.ISO_8859_1);
            cm40.setVin(vin);

            String pileCode=redisTool.getPileCode(null, msg.getDeviceCode(), channel);
            cm40.setPileCode(pileCode);
            int gunNo=TypeConversion.getUnsignedByte(data.getGunNo());
            String gunCode=redisTool.getGunCode(null, msg.getDeviceCode(), String.valueOf(gunNo),channel);
            cm40.setGunCode(gunCode);
            cm40.setOrderNo(TypeConversion.bytes2orderNo(data.getOrderNo()));

            // 发送通知使用
            String stationCode = redisTool.getStationCode(msg.getDeviceCode(), channel);
            cm40.setStationCode(stationCode);
            cm40.setOperatorCode(redisTool.getOperatorCode(stationCode,msg.getDeviceCode(), channel));

            // 5b报文和40报文 桩发送顺序异常 当已经收到5B失败时拦截 忽略40报文
            if (!StringUtils.isBlank(stringRedisTemplate.opsForValue().get(Q5B_MESSAGE_FAIL + cm40.getOrderNo()))) {
                log.error("0x40,已收到0x5B失败报文,抛弃当前报文,{}", FastJsonUtils.toJSONStringUp(cm40));
                return;
            }
            // 存入redis,过期时间1小时 当先接收到40报文时,忽略5B报文
            stringRedisTemplate.opsForValue().set(Q40_MESSAGE + cm40.getOrderNo(), cm40.getOrderNo(), ORDER_EXPIRATION_TIME, TimeUnit.SECONDS);

            upHandler.covertDataByCmd40(cm40);
            rabbitTemplate.convertAndSend(PlatformExchangeConstant.DATA_KEY, PlatformQueueConstant.Q40_KEY, FastJsonUtils.toJSONStringUp(cm40));

            log.info("0x40,数据: {}", FastJsonUtils.toJSONStringUp(cm40));
            sendTcpProxyQueue(TcpProxyBaseDataDto.builder()
                    .header(
                            TcpProxyBaseDataDto.Header.builder()
                                    .deviceCode(cm40.getDeviceCode())
                                    .currTime(cm40.getCurrTime())
                                    .protocolName(cm40.getProtocolName())
                                    .protocolKey(msg.getProtocolKey())
                                    .build())
                    .dataBody(cm40).build());
        } catch (Exception e) {
            log.error("0x40,{}",e);
        }

    }

    private void sendTcpProxyQueue(Object data) {
        try {
            //转发iot平台
            rabbitTemplate.convertAndSend(IotForwardRabbitMQConstants.EXCHANGE.CQ40H, IotForwardRabbitMQConstants.ROUTE_KEY.CQ40H, FastJsonUtils.toJSONStringUp(data));
        } catch (Exception e) {
            log.error(e.getMessage());
        }
    }
}
