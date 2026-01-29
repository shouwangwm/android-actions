const protobuf = require('protobufjs');

let root = null;

// 加载 Protocol Buffers 定义
async function loadProto() {
  try {
    // 使用绝对路径确保能正确找到文件
    const path = require('path');
    const protoFilePath = path.join(__dirname, '../proto/messages.proto');
    root = await protobuf.load(protoFilePath);
    console.log('✅ Protocol Buffers 定义加载成功');
    return root;
  } catch (error) {
    console.error('❌ 加载 Protocol Buffers 定义失败:', error);
    throw error;
  }
}

// 编码消息
function encodeMessage(messageType, messageData) {
  if (!root) {
    throw new Error('Protocol Buffers 定义未加载');
  }

  const MessageClass = root.lookupType(`messageApp.${messageType}`);
  const errMsg = MessageClass.verify(messageData);
  if (errMsg) {
    throw new Error(errMsg);
  }

  const message = MessageClass.create(messageData);
  const buffer = MessageClass.encode(message).finish();
  return buffer;
}

// 解码消息
function decodeMessage(messageType, buffer) {
  if (!root) {
    throw new Error('Protocol Buffers 定义未加载');
  }

  const MessageClass = root.lookupType(`messageApp.${messageType}`);
  const message = MessageClass.decode(buffer);
  return MessageClass.toObject(message);
}

// 编码消息容器
function encodeMessageContainer(messageType, messageData) {
    if (!root) {
        throw new Error('Protocol Buffers 定义未加载');
    }

    const MessageContainer = root.lookupType('messageApp.MessageContainer');
    
    // 使用正确的字段名映射
    let fieldName;
    switch (messageType) {
        case 'chatMessage':
            fieldName = 'chatMessage';
            break;
        case 'systemMessage':
            fieldName = 'systemMessage';
            break;
        case 'errorMessage':
            fieldName = 'errorMessage';
            break;
        case 'loginSuccess':
            fieldName = 'loginSuccess';
            break;
        case 'loginError':
            fieldName = 'loginError';
            break;
        case 'groupMembers':
            fieldName = 'groupMembers';
            break;
        case 'recallMessage':
            fieldName = 'recallMessage';
            break;
        default:
            throw new Error('未知的消息类型: ' + messageType);
    }

    const containerData = {
        [fieldName]: messageData
    };

    const errMsg = MessageContainer.verify(containerData);
    if (errMsg) {
        throw new Error(errMsg);
    }

    const container = MessageContainer.create(containerData);
    const buffer = MessageContainer.encode(container).finish();
    return buffer;
}

// 解码消息容器
function decodeMessageContainer(buffer) {
  if (!root) {
    throw new Error('Protocol Buffers 定义未加载');
  }

  const MessageContainer = root.lookupType('messageApp.MessageContainer');
  const container = MessageContainer.decode(buffer);
  const containerObj = MessageContainer.toObject(container);
  return containerObj;
}

module.exports = {
  loadProto,
  encodeMessage,
  decodeMessage,
  encodeMessageContainer,
  decodeMessageContainer
};
