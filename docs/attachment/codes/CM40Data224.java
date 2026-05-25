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

/**
 * 上行-40H-VIN鉴权
 * @author steve
 */
@MessageDataAnnotation(command = CommandEnum.C40,version = {ProtocolVersion.V_224_TO_224,ProtocolVersion.V_225_TO_9999})
@Data
@EqualsAndHashCode(callSuper=false)
public class CM40Data224 extends BaseData{

    /**
     * 时标
     */
    private byte[] time=new byte[6];

    private byte[] vin=new byte[17];

    private byte gunNo;

    private byte[] orderNo=new byte[32];

}
