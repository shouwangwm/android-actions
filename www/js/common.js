// 配置项
const EXTERNAL_DOMAIN = '94766d6.r15.vip.cpolar.cn'; // 外部域名
const LOCAL_PORT = 9667; // 本地端口

// Protocol Buffers 消息类型映射
const MESSAGE_TYPES = {
  0: 'text',
  1: 'image',
  2: 'voice',
  3: 'system',
  4: 'error',
  5: 'loginSuccess',
  6: 'loginError',
  7: 'groupMembers',
  8: 'joinGroupSuccess',
  9: 'recallMessage'
};

// WebSocket连接状态常量
const WS_STATUS = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3
};

// WebSocket连接
let ws;
let wsStatus = WS_STATUS.CLOSED;
// 从会话存储获取clientId，如果没有则生成新的
let clientId = sessionStorage.getItem('messageAppClientId') || ('client_' + Math.random().toString(36).substr(2, 9));
// 保存clientId到会话存储
sessionStorage.setItem('messageAppClientId', clientId);

// 重连相关
let reconnectAttempts = 0;
let maxReconnectAttempts = 5;
let reconnectDelay = 1000; // 初始重连延迟（毫秒）
let maxReconnectDelay = 30000; // 最大重连延迟（毫秒）
let reconnectTimer = null;
let reconnectPaused = false;

// 回调函数
let connectCallback = null;
let messageCallback = null;

// 本地用户缓存
let userCache = new Map(); // 本地缓存用户信息，key为userId，value为用户信息对象
let closeCallback = null;

// 图片消息处理
let pendingImageMetadata = null; // 存储待处理的图片元数据

// 群组相关
let currentGroup = null;
let currentNickname = null;

// 获取URL参数
function getUrlParams() {
    const params = new URLSearchParams(window.location.search);
    return {
        groupId: params.get('groupId'),
        groupName: params.get('groupName'),
        nickname: params.get('nickname')
    };
}

// 初始化WebSocket连接
function initWebSocket(onConnectCallback, onMessageCallback, onCloseCallback) {
    // 保存回调函数
    connectCallback = onConnectCallback;
    messageCallback = onMessageCallback;
    closeCallback = onCloseCallback;
    
    // 重置重连尝试次数
    reconnectAttempts = 0;
    reconnectDelay = 1000;
    
    // 关闭现有的连接
    if (ws) {
        try {
            ws.close(1000, '重新初始化连接');
        } catch (error) {
            console.error('❌ 关闭现有WebSocket连接失败:', error);
        }
    }
    
    // 连接WebSocket服务器
    connectWebSocket();
}

// 连接WebSocket服务器
function connectWebSocket() {
    if (wsStatus === WS_STATUS.CONNECTING) {
        console.log('⚠️ WebSocket正在连接中，跳过重复连接');
        return;
    }
    
    const statusElement = document.getElementById('connectionStatus');
    
    // 更新连接状态
    wsStatus = WS_STATUS.CONNECTING;
    
    // 检查当前页面的协议和域名
    const currentProtocol = window.location.protocol;
    const currentHost = window.location.hostname;
    
    // 判断是否是本地开发环境
    const isLocal = currentHost === 'localhost' || currentHost === '127.0.0.1' || currentHost === '0.0.0.0';
    
    let wsUrl;
    if (isLocal) {
        // 本地环境：使用ws协议和配置的本地端口
        wsUrl = `ws://localhost:${LOCAL_PORT}`;
    } else {
        // 外部环境：根据当前页面协议选择WebSocket协议，cpolar隧道不需要指定端口号
        const wsProtocol = currentProtocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${wsProtocol}//${EXTERNAL_DOMAIN}`;
    }
    
    console.log(`📞 尝试连接WebSocket服务器 [${reconnectAttempts + 1}/${maxReconnectAttempts}]: ${wsUrl}`);
    
    try {
        ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
            console.log('✅ WebSocket连接已建立');
            
            // 更新连接状态
            wsStatus = WS_STATUS.OPEN;
            
            // 重置重连计数
            reconnectAttempts = 0;
            reconnectDelay = 1000;
            
            // 更新UI状态
            if (statusElement) {
                statusElement.textContent = '已连接';
                statusElement.classList.remove('not-connected');
            }
            
            // 调用连接成功回调
            if (connectCallback) {
                connectCallback();
            }
        };
        
        ws.onmessage = async (event) => {
            // 确保连接是打开状态
            if (wsStatus !== WS_STATUS.OPEN) {
                console.warn('⚠️ WebSocket未打开，忽略消息');
                return;
            }
            
            try {
                if (event.data instanceof Blob) {
                    // 处理二进制消息
                    event.data.arrayBuffer().then(buffer => {
                        console.log('📦 收到二进制消息，长度:', buffer.byteLength);
                        
                        // 检查是否有待处理的图片元数据
                        if (pendingImageMetadata) {
                            // 处理图片二进制数据
                            console.log('🖼️  收到图片二进制数据，长度:', buffer.byteLength);
                            
                            // 创建Blob URL
                            const blob = new Blob([buffer], { type: 'image/jpeg' });
                            const imageUrl = URL.createObjectURL(blob);
                            
                            // 构建完整的图片消息对象
                            const imageMessage = {
                                id: pendingImageMetadata.id,
                                senderId: pendingImageMetadata.senderId,
                                senderNickname: pendingImageMetadata.senderNickname,
                                content: imageUrl,
                                messageType: 'image',
                                timestamp: pendingImageMetadata.timestamp,
                                sent: false,
                                type: 'message',
                                data: {
                                    groupId: pendingImageMetadata.groupId
                                }
                            };
                            
                            // 调用消息处理回调
                            if (messageCallback) {
                                messageCallback(imageMessage);
                            }
                            
                            // 清除待处理的元数据
                            pendingImageMetadata = null;
                        } else {
                            // 尝试解码Protocol Buffers消息
                            try {
                                // 尝试解码消息
                                const decodedMessage = decodeMessageContainer(new Uint8Array(buffer));
                                if (decodedMessage) {
                                    console.log('📦 解码后的消息:', decodedMessage);
                                    
                                    // 转换为标准消息格式
                                    const standardMessage = convertProtobufToStandardMessage(decodedMessage);
                                    if (standardMessage) {
                                        // 调用消息处理回调
                                        if (messageCallback) {
                                            messageCallback(standardMessage);
                                        }
                                    }
                                } else {
                                    console.warn('⚠️ 解码消息返回null，忽略此消息');
                                }
                            } catch (err) {
                                console.error('❌ 解码二进制消息失败:', err);
                            }
                        }
                    }).catch(err => {
                        console.error('❌ 处理二进制消息失败:', err);
                    });
                } else if (typeof event.data === 'string') {
                    // 处理JSON消息
                    try {
                        const message = JSON.parse(event.data);
                        
                        // 处理图片元数据消息
                        if (message.type === 'imageMetadata') {
                            console.log('📋 收到图片元数据:', message);
                            pendingImageMetadata = message;
                        } else {
                            // 调用消息处理回调
                            if (messageCallback) {
                                messageCallback(message);
                            }
                        }
                    } catch (parseError) {
                        console.error('❌ 解析JSON消息失败:', parseError);
                    }
                } else {
                    console.warn('⚠️ 未知消息类型:', typeof event.data);
                }
            } catch (error) {
                console.error('❌ 处理消息失败:', error);
            }
        };
        
        ws.onclose = (event) => {
            console.log('❌ WebSocket连接已关闭:', event.code, event.reason);
            
            // 更新连接状态
            wsStatus = WS_STATUS.CLOSED;
            
            // 更新UI状态
            if (statusElement) {
                statusElement.textContent = '未连接';
                statusElement.classList.add('not-connected');
            }
            
            // 调用关闭回调
            if (closeCallback) {
                closeCallback(event);
            }
            
            // 如果不是手动关闭，尝试重连
            if (event.code !== 1000 && !reconnectPaused) {
                scheduleReconnect();
            }
        };
        
        ws.onerror = (error) => {
            console.error('❌ WebSocket错误:', error);
            
            // 更新UI状态
            if (statusElement) {
                statusElement.textContent = '连接错误';
                statusElement.classList.add('not-connected');
            }
        };
    } catch (error) {
        console.error('❌ 创建WebSocket连接失败:', error);
        
        // 更新连接状态
        wsStatus = WS_STATUS.CLOSED;
        
        // 更新UI状态
        if (statusElement) {
            statusElement.textContent = '连接错误';
        }
        
        // 尝试重连
        scheduleReconnect();
    }
}

// 安排重连
function scheduleReconnect() {
    if (reconnectPaused || reconnectAttempts >= maxReconnectAttempts) {
        console.log('❌ 重连已暂停或达到最大尝试次数');
        return;
    }
    
    // 清除现有的重连定时器
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }
    
    // 增加重连延迟（指数退避）
    reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
    reconnectAttempts++;
    
    console.log(`⏱️  将在 ${reconnectDelay}ms 后尝试第 ${reconnectAttempts} 次重连`);
    
    // 设置重连定时器
    reconnectTimer = setTimeout(() => {
        connectWebSocket();
    }, reconnectDelay);
}

// 暂停重连
function pauseReconnect() {
    reconnectPaused = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    console.log('⏸️  重连已暂停');
}

// 恢复重连
function resumeReconnect() {
    reconnectPaused = false;
    scheduleReconnect();
    console.log('▶️  重连已恢复');
}

// 手动关闭WebSocket连接
function closeWebSocket() {
    pauseReconnect();
    if (ws) {
        try {
            ws.close(1000, '手动关闭');
        } catch (error) {
            console.error('❌ 关闭WebSocket连接失败:', error);
        }
        ws = null;
    }
    wsStatus = WS_STATUS.CLOSED;
    console.log('🚪 手动关闭WebSocket连接');
}

// 编码消息容器（客户端使用）
function encodeMessageContainer(messageType, messageData) {
    if (!protoRoot) {
        console.warn('⚠️ Protocol Buffers定义未加载，回退到JSON格式');
        return null;
    }

    try {
        const MessageContainer = protoRoot.lookupType('messageApp.MessageContainer');
        
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
                console.warn('⚠️ 未知的消息类型:', messageType);
                return null;
        }

        const containerData = {
            [fieldName]: messageData
        };

        const errMsg = MessageContainer.verify(containerData);
        if (errMsg) {
            console.warn('⚠️ 消息验证失败:', errMsg);
            return null;
        }

        const container = MessageContainer.create(containerData);
        const buffer = MessageContainer.encode(container).finish();
        return buffer;
    } catch (error) {
        console.error('❌ 编码消息失败:', error);
        return null;
    }
}

// 发送消息给服务器
function sendToServer(message) {
    if (message.messageType === 'image' && message.originalFile) {
        // 对于图片消息，使用WebSocket直接发送二进制数据
        console.log('📤 发送图片消息 (二进制)');
        
        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                // 读取文件为ArrayBuffer
                const reader = new FileReader();
                reader.onload = (e) => {
                    const arrayBuffer = e.target.result;
                    // 构建图片元数据消息
                    const imageMetadataMessage = {
                        type: 'imageMetadata',
                        id: message.id || Date.now(),
                        senderId: message.senderId || sessionStorage.getItem('messageAppUserId'),
                        senderNickname: message.senderNickname || sessionStorage.getItem('messageAppNickname'),
                        messageType: 'image',
                        timestamp: new Date().toISOString(),
                        data: {
                            groupId: message.data?.groupId || currentGroup?.groupId
                        }
                    };
                    // 发送图片元数据（JSON格式）
                    ws.send(JSON.stringify(imageMetadataMessage));
                    // 发送二进制图片数据
                    ws.send(arrayBuffer);
                    console.log('✅ 图片消息发送成功');
                };
                reader.onerror = (error) => {
                    console.error('❌ 读取图片文件失败:', error);
                    alert('发送失败：文件读取错误');
                };
                reader.readAsArrayBuffer(message.originalFile);
            } catch (error) {
                console.error('❌ 发送图片消息失败:', error);
                alert('发送失败：网络错误');
            }
        } else {
            console.error('❌ WebSocket未连接，无法发送消息');
            alert('发送失败：网络未连接');
        }
    } else if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            let encodedBuffer = null;
            
            // 尝试使用Protocol Buffers编码
            if (message.type === 'message') {
                // 聊天消息
                encodedBuffer = encodeMessageContainer('chatMessage', {
                    id: message.id || Date.now().toString(),
                    senderId: String(message.senderId || sessionStorage.getItem('messageAppUserId')),
                    senderNickname: message.senderNickname || sessionStorage.getItem('messageAppNickname'),
                    content: message.content,
                    messageType: message.messageType === 'text' ? 0 : message.messageType === 'image' ? 1 : message.messageType === 'voice' ? 2 : 0,
                    timestamp: message.timestamp || new Date().toISOString(),
                    sent: message.sent || false,
                    groupId: message.data && message.data.groupId ? String(message.data.groupId) : null
                });
            } else if (message.type === 'system') {
                // 系统消息
                encodedBuffer = encodeMessageContainer('systemMessage', {
                    content: message.content,
                    senderId: String(message.senderId || 'client'),
                    timestamp: message.timestamp || new Date().toISOString()
                });
            } else if (message.type === 'error') {
                // 错误消息
                encodedBuffer = encodeMessageContainer('errorMessage', {
                    content: message.content,
                    senderId: String(message.senderId || 'client'),
                    timestamp: message.timestamp || new Date().toISOString()
                });
            } else if (message.type === 'recallMessage') {
                // 撤回消息
                encodedBuffer = encodeMessageContainer('recallMessage', {
                    messageId: String(message.data.messageId),
                    groupId: String(message.data.groupId),
                    senderId: String(message.senderId || 'client'),
                    timestamp: message.timestamp || new Date().toISOString()
                });
            }

            if (encodedBuffer) {
                // 使用Protocol Buffers发送
                console.log('📤 发送消息 (Protocol Buffers)，长度:', encodedBuffer.byteLength);
                ws.send(encodedBuffer);
            } else {
                // 回退到JSON格式
                const jsonMessage = JSON.stringify(message);
                console.log('📤 发送消息 (JSON):', jsonMessage);
                ws.send(jsonMessage);
            }
        } catch (error) {
            console.error('❌ 消息序列化失败:', error);
            alert('发送失败：消息格式错误');
        }
    } else {
        console.error('❌ WebSocket未连接，无法发送消息');
        
        // 如果WebSocket未连接，尝试使用fetch API发送消息
        if (message.type === 'message') {
            fetch('/api/sendMessage', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(message)
            })
            .then(response => response.json())
            .then(data => {
                console.log('✅ 消息发送成功 (HTTP):', data);
            })
            .catch(error => {
                console.error('❌ 消息发送失败 (HTTP):', error);
                alert('发送失败：网络错误');
            });
        } else {
            alert('发送失败：连接已断开');
        }
    }
}

// 事件监听器引用，便于后续移除
let beforeUnloadListener = null;
let enterSendListener = null;
let resizeListener = null;

// 页面关闭前清理
function setupBeforeUnload() {
    // 移除之前的事件监听器，避免重复添加
    if (beforeUnloadListener) {
        window.removeEventListener('beforeunload', beforeUnloadListener);
    }
    
    beforeUnloadListener = () => {
        // 离开群组
        if (currentGroup && ws && ws.readyState === WebSocket.OPEN) {
            sendToServer({
                type: 'leaveGroup',
                data: {
                    groupId: currentGroup.groupId
                }
            });
        }
        // 关闭WebSocket连接
        closeWebSocket();
    };
    
    window.addEventListener('beforeunload', beforeUnloadListener);
}

// 移除页面关闭前的事件监听器
function removeBeforeUnload() {
    if (beforeUnloadListener) {
        window.removeEventListener('beforeunload', beforeUnloadListener);
        beforeUnloadListener = null;
    }
}

// 添加系统消息
function addSystemMessage(content) {
    const messagesDiv = document.getElementById('messages');
    if (messagesDiv) {
        const systemDiv = document.createElement('div');
        systemDiv.style.cssText = 'text-align: center; font-size: 10px; color: #666; margin: 8px 0;';
        systemDiv.textContent = content;
        messagesDiv.appendChild(systemDiv);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
}

// 更新成员列表
let currentMembers = [];
function updateMembersList(members) {
    currentMembers = members;
    
    // 缓存所有成员信息到本地
    members.forEach(member => {
        userCache.set(member.userId, member);
    });
}

// 显示成员列表
function showMembersList() {
    const modal = document.getElementById('membersModal');
    const membersList = document.getElementById('membersList');
    if (modal && membersList) {
        membersList.innerHTML = '';
        
        // 确保成员列表至少包含当前用户
        let displayMembers = currentMembers;
        if (displayMembers.length === 0 && currentNickname) {
            displayMembers = [currentNickname];
        }
        
        if (displayMembers.length === 0) {
            membersList.innerHTML = '<p>暂无成员</p>';
        } else {
            displayMembers.forEach(member => {
                const memberItem = document.createElement('div');
                memberItem.className = 'member-item';
                
                // 检查member是否是对象（包含头像信息）
                if (typeof member === 'object' && member.nickname) {
                    // 从本地缓存获取用户信息
                    let avatarUrl = 'icon/no_icon.png'; // 默认头像
                    const cachedUser = userCache.get(member.userId);
                    if (cachedUser && cachedUser.avatar) {
                        avatarUrl = cachedUser.avatar;
                    } else if (member.avatar) {
                        avatarUrl = member.avatar;
                    }
                    
                    // 头像HTML
                    const avatarHtml = `<div class="user-avatar-small"><img src="${avatarUrl}" alt="头像"></div>`;
                    
                    memberItem.innerHTML = `
                        ${avatarHtml}
                        <span style="margin-left: 12px;">${member.nickname}</span>
                    `;
                } else {
                    // 旧格式，只有昵称字符串
                    memberItem.textContent = member;
                }
                
                membersList.appendChild(memberItem);
            });
        }
        
        modal.classList.remove('hidden');
    }
}

// 关闭成员列表
function closeMembersModal() {
    const modal = document.getElementById('membersModal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

// 点击模态框外部关闭
function setupModalClose() {
    window.onclick = function(event) {
        const modal = document.getElementById('membersModal');
        if (event.target === modal) {
            closeMembersModal();
        }
    };
}

// 消息容器引用缓存
let messagesContainer = null;

// 消息批处理队列
let messageBatch = [];
let batchTimeout = null;

// 批量处理消息的间隔时间（毫秒）
const BATCH_INTERVAL = 100;

// 最大消息数量限制
const MAX_MESSAGES = 100;

// 超过最大消息数量时，每次删除的消息数量
const MESSAGES_TO_DELETE = 20;

// 获取消息容器
function getMessagesContainer() {
    if (!messagesContainer) {
        messagesContainer = document.getElementById('messages');
    }
    return messagesContainer;
}

// 添加消息到界面
function addMessage(message) {
    const messagesDiv = getMessagesContainer();
    if (!messagesDiv) return;
    
    // 添加到批处理队列
    messageBatch.push(message);
    
    // 如果没有正在处理的批处理，启动一个
    if (!batchTimeout) {
        batchTimeout = setTimeout(processMessageBatch, BATCH_INTERVAL);
    }
}

// 处理消息批处理
function processMessageBatch() {
    const messagesDiv = getMessagesContainer();
    if (!messagesDiv || messageBatch.length === 0) {
        batchTimeout = null;
        return;
    }
    
    // 创建文档片段，减少DOM操作
    const fragment = document.createDocumentFragment();
    
    // 处理队列中的所有消息
    for (const message of messageBatch) {
        const messageDiv = createMessageElement(message);
        fragment.appendChild(messageDiv);
    }
    
    // 清空队列
    messageBatch = [];
    
    // 批量添加到DOM
    messagesDiv.appendChild(fragment);
    
    // 检查消息数量，超过限制则删除旧消息
    cleanupOldMessages();
    
    // 自动滚动到最新消息
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    // 清除定时器
    batchTimeout = null;
}

// 清理旧消息，保持消息数量在合理范围内
function cleanupOldMessages() {
    const messagesDiv = getMessagesContainer();
    if (!messagesDiv) return;
    
    const messageElements = messagesDiv.querySelectorAll('.message');
    const messageCount = messageElements.length;
    
    // 如果消息数量超过最大限制，删除最旧的消息
    if (messageCount > MAX_MESSAGES) {
        // 删除最旧的消息
        for (let i = 0; i < MESSAGES_TO_DELETE && i < messageElements.length; i++) {
            // 释放消息资源
            cleanupMessageResources(messageElements[i]);
            // 删除DOM元素
            messageElements[i].remove();
        }
        
        console.log(`✅ 已清理 ${MESSAGES_TO_DELETE} 条旧消息，当前消息数量: ${messagesDiv.querySelectorAll('.message').length}`);
    }
}

// 清理单个消息的资源
function cleanupMessageResources(messageElement) {
    if (!messageElement) return;
    
    // 清理图片资源
    const imgElement = messageElement.querySelector('.message-image');
    if (imgElement) {
        // 清空src，释放内存
        imgElement.src = '';
        // 移除事件监听器
        imgElement.onclick = null;
    }
    
    // 清理音频资源
    const voicePlayer = messageElement.querySelector('.voice-player');
    if (voicePlayer && voicePlayer.audio) {
        // 停止播放
        voicePlayer.audio.pause();
        voicePlayer.audio.currentTime = 0;
        // 释放音频对象
        voicePlayer.audio = null;
        // 移除事件监听器
        voicePlayer.onclick = null;
    }
    
    // 移除所有子元素
    while (messageElement.firstChild) {
        cleanupMessageResources(messageElement.firstChild);
        messageElement.removeChild(messageElement.firstChild);
    }
}

// 创建消息元素
function createMessageElement(message) {
    const messageDiv = document.createElement('div');
    messageDiv.dataset.messageId = message.id || Date.now();
    
    // 根据消息类型设置不同的样式类
    const currentUserId = sessionStorage.getItem('messageAppUserId');
    const isSentMessage = message.sent || (message.senderId === currentUserId);
    
    if (isSentMessage) {
        messageDiv.className = 'message sent';
        // 为发送的消息添加长按菜单
        messageDiv.oncontextmenu = (e) => {
            e.preventDefault();
            showMessageMenu(e, messageDiv, message);
        };
    } else {
        messageDiv.className = 'message received';
    }
    
    // 创建头像
    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'message-avatar';
    
    // 从本地缓存获取用户头像信息
    let avatarUrl = 'icon/no_icon.png'; // 默认头像
    const cachedUser = userCache.get(message.senderId);
    if (cachedUser && cachedUser.avatar) {
        avatarUrl = cachedUser.avatar;
    } else if (message.senderId === sessionStorage.getItem('messageAppUserId')) {
        // 如果是当前用户，使用会话存储中的头像
        const savedAvatar = sessionStorage.getItem('messageAppAvatar');
        if (savedAvatar) {
            avatarUrl = savedAvatar;
        }
    }
    
    // 添加头像图片
    avatarDiv.innerHTML = `<img src="${avatarUrl}" alt="头像">`;
    
    // 创建消息气泡
    const bubbleDiv = document.createElement('div');
    bubbleDiv.className = 'message-bubble';
    bubbleDiv.style.pointerEvents = 'auto';
    
    // 创建消息头部
    const headerDiv = document.createElement('div');
    headerDiv.className = 'message-header';
    
    // 发送者昵称
    const senderSpan = document.createElement('span');
    senderSpan.className = 'message-sender';
    senderSpan.textContent = message.senderNickname;
    
    // 空白间隔
    const spaceSpan = document.createElement('span');
    spaceSpan.textContent = ' ';
    
    // 时间戳
    const timeSpan = document.createElement('span');
    timeSpan.className = 'message-meta';
    timeSpan.textContent = new Date(message.timestamp).toLocaleTimeString();
    
    // 组装头部
    headerDiv.appendChild(senderSpan);
    headerDiv.appendChild(spaceSpan);
    headerDiv.appendChild(timeSpan);
    
    // 创建消息内容
    const contentDiv = createMessageContent(message);
    contentDiv.style.pointerEvents = 'auto';
    
    // 组装气泡
    bubbleDiv.appendChild(headerDiv);
    bubbleDiv.appendChild(contentDiv);
    
    // 组装消息元素
    if (isSentMessage) {
        // 发送的消息：头像在右，气泡在左
        messageDiv.appendChild(bubbleDiv);
        messageDiv.appendChild(avatarDiv);
    } else {
        // 接收的消息：头像在左，气泡在右
        messageDiv.appendChild(avatarDiv);
        messageDiv.appendChild(bubbleDiv);
    }
    
    return messageDiv;
}

// 显示消息菜单
function showMessageMenu(event, messageElement, message) {
    // 移除之前的菜单
    removeMessageMenu();
    
    // 创建菜单元素
    const menu = document.createElement('div');
    menu.className = 'message-menu';
    menu.style.position = 'fixed';
    menu.style.left = event.clientX + 'px';
    menu.style.top = event.clientY + 'px';
    menu.style.backgroundColor = 'white';
    menu.style.border = '1px solid #ddd';
    menu.style.borderRadius = '4px';
    menu.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
    menu.style.zIndex = '1000';
    menu.id = 'messageMenu';
    
    // 添加撤回选项
    const recallOption = document.createElement('div');
    recallOption.className = 'message-menu-item';
    recallOption.textContent = '撤回';
    recallOption.onclick = () => {
        recallMessage(messageElement, message);
        removeMessageMenu();
    };
    menu.appendChild(recallOption);
    
    // 添加到页面
    document.body.appendChild(menu);
    
    // 点击其他地方关闭菜单
    setTimeout(() => {
        document.addEventListener('click', removeMessageMenu);
    }, 0);
}

// 移除消息菜单
function removeMessageMenu() {
    const menu = document.getElementById('messageMenu');
    if (menu) {
        menu.remove();
    }
    document.removeEventListener('click', removeMessageMenu);
}

// 撤回消息
function recallMessage(messageElement, message) {
    if (!currentGroup) return;
    
    // 检查消息是否超过1分钟
    const messageTime = new Date(message.timestamp).getTime();
    const now = Date.now();
    const timeDiff = now - messageTime;
    const oneMinute = 60 * 1000; // 1分钟
    
    if (timeDiff > oneMinute) {
        alert('消息已超过1分钟，无法撤回');
        return;
    }
    
    // 发送撤回消息到服务器
    sendToServer({
        type: 'recallMessage',
        data: {
            groupId: currentGroup.groupId,
            messageId: message.id
        }
    });
    
    // 更新本地消息显示
    updateMessageToRecalled(messageElement);
}

// 更新消息为已撤回状态
function updateMessageToRecalled(messageElement) {
    const bubbleDiv = messageElement.querySelector('.message-bubble');
    if (bubbleDiv) {
        // 清空原有内容
        bubbleDiv.innerHTML = '';
        
        // 创建撤回提示
        const recallDiv = document.createElement('div');
        recallDiv.className = 'message-recalled';
        recallDiv.textContent = '消息已撤回';
        
        bubbleDiv.appendChild(recallDiv);
    }
    
    // 移除长按菜单事件
    messageElement.oncontextmenu = null;
}

// 处理撤回消息
function handleRecallMessage(message) {
    const messageId = message.data.messageId;
    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
    
    if (messageElement) {
        updateMessageToRecalled(messageElement);
    }
}

// 创建消息内容
function createMessageContent(message) {
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    
    // 使用messageType字段判断消息类型，因为服务器转发的消息中type是'message'
    const msgType = message.messageType || message.type;
    
    console.log('📋 创建消息内容:', { messageType: message.messageType, type: message.type, msgType, content: message.content });
    
    if (msgType === 'text') {
        contentDiv.textContent = message.content;
    } else if (msgType === 'image') {
        // 图片消息
        console.log('🖼️  创建图片消息内容，图片URL:', message.content);
        const imgElement = document.createElement('img');
        imgElement.className = 'message-image';
        imgElement.alt = '图片';
        imgElement.src = message.content;
        imgElement.style.cursor = 'pointer'; // 确保鼠标指针显示为指针
        imgElement.onclick = (e) => {
            // 阻止事件冒泡，避免触发父元素的事件
            e.stopPropagation();
            e.preventDefault();
            console.log('🖼️  点击图片，预览URL:', message.content);
            // 确保message.content是一个有效的URL
            if (message.content && message.content.length > 0) {
                previewImage(message.content);
            } else {
                console.error('❌ 图片URL无效:', message.content);
            }
        };
        
        // 添加一些额外的样式，确保图片可点击
        imgElement.style.userSelect = 'none';
        imgElement.style.pointerEvents = 'auto';
        
        contentDiv.appendChild(imgElement);
    } else if (msgType === 'voice') {
        // 语音消息
        const voiceIconSpan = document.createElement('span');
        voiceIconSpan.textContent = '🎵 语音';
        
        const voicePlayerDiv = document.createElement('div');
        voicePlayerDiv.className = 'voice-player';
        voicePlayerDiv.onclick = (e) => toggleVoicePlayback(e.currentTarget, message.content, message.duration);
        
        const playIconSpan = document.createElement('span');
        playIconSpan.className = 'play-icon';
        playIconSpan.textContent = '▶️';
        
        const durationDiv = document.createElement('div');
        durationDiv.className = 'voice-duration';
        durationDiv.textContent = `${message.duration}s`;
        
        voicePlayerDiv.appendChild(playIconSpan);
        voicePlayerDiv.appendChild(durationDiv);
        
        contentDiv.appendChild(voiceIconSpan);
        contentDiv.appendChild(voicePlayerDiv);
    }
    
    return contentDiv;
}

// 预览图片
function previewImage(src) {
    console.log('📤 预览图片，URL:', src);
    try {
        // 确保src是一个有效的URL
        if (src && src.length > 0) {
            // 使用图片预览弹窗
            const modal = document.getElementById('imagePreviewModal');
            const imgElement = document.getElementById('previewImage');
            
            if (modal && imgElement) {
                // 设置图片源
                imgElement.src = src;
                // 显示弹窗
                modal.classList.remove('hidden');
                console.log('✅ 图片预览已打开');
            } else {
                console.error('❌ 图片预览弹窗元素未找到');
                alert('无法打开图片预览，页面元素缺失');
            }
        } else {
            console.error('❌ 图片URL无效:', src);
            alert('图片URL无效，无法预览');
        }
    } catch (error) {
        console.error('❌ 预览图片失败:', error);
        alert('预览图片失败，请重试');
    }
}

// 切换语音播放
function toggleVoicePlayback(element, audioUrl, duration) {
    const playIcon = element.querySelector('.play-icon');
    
    // 停止其他正在播放的语音
    document.querySelectorAll('.voice-player.playing').forEach(player => {
        if (player !== element) {
            stopVoicePlayback(player);
        }
    });
    
    if (element.classList.contains('playing')) {
        stopVoicePlayback(element);
    } else {
        startVoicePlayback(element, audioUrl);
    }
}

// 开始语音播放
function startVoicePlayback(element, audioUrl) {
    const playIcon = element.querySelector('.play-icon');
    const audio = new Audio(audioUrl);
    
    element.classList.add('playing');
    playIcon.textContent = '⏸️';
    
    audio.play().catch(err => {
        console.error('播放失败:', err);
        stopVoicePlayback(element);
    });
    
    audio.onended = () => {
        stopVoicePlayback(element);
    };
    
    element.audio = audio;
}

// 停止语音播放
function stopVoicePlayback(element) {
    const playIcon = element.querySelector('.play-icon');
    
    if (element.audio) {
        element.audio.pause();
        element.audio.currentTime = 0;
        element.audio = null;
    }
    
    element.classList.remove('playing');
    playIcon.textContent = '▶️';
}

// 设置图片输入处理
function setupImageInput() {
    const imageInput = document.getElementById('imageInput');
    if (imageInput) {
        imageInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                // 为了预览，我们仍然需要base64格式
                const reader = new FileReader();
                reader.onload = (event) => {
                    // 存储原始文件和base64预览
                    showMediaPreview({
                        type: 'image',
                        content: event.target.result, // base64格式用于预览
                        originalFile: file // 原始文件用于发送
                    });
                };
                reader.readAsDataURL(file);
            }
        });
    }
}

// 设置shift+回车发送功能
function setupEnterSend(sendFunction) {
    const input = document.getElementById('messageInput');
    if (!input) return;
    
    // 移除之前的事件监听器，避免重复添加
    if (enterSendListener) {
        input.removeEventListener('keydown', enterSendListener);
    }
    
    enterSendListener = (e) => {
        // 按下回车键且按下Shift键时发送消息
        if (e.key === 'Enter' && e.shiftKey) {
            e.preventDefault(); // 阻止换行
            sendFunction(); // 发送消息
        }
    };
    
    input.addEventListener('keydown', enterSendListener);
}

// 移除shift+回车发送的事件监听器
function removeEnterSend() {
    const input = document.getElementById('messageInput');
    if (input && enterSendListener) {
        input.removeEventListener('keydown', enterSendListener);
        enterSendListener = null;
    }
}

// 媒体预览
let mediaPreview = null;

// 显示媒体预览
function showMediaPreview(data) {
    const previewDiv = document.getElementById('mediaPreview');
    if (!previewDiv) return;
    
    // 先清除之前的预览内容和事件监听器
    clearMediaPreview();
    
    let previewContent;
    
    if (data.type === 'image') {
        // 使用createElement创建元素，避免innerHTML
        const imgElement = document.createElement('img');
        imgElement.className = 'preview-image';
        imgElement.src = data.content;
        
        const textSpan = document.createElement('span');
        textSpan.textContent = '图片';
        
        previewContent = document.createDocumentFragment();
        previewContent.appendChild(imgElement);
        previewContent.appendChild(textSpan);
    } else if (data.type === 'voice') {
        const voiceIconSpan = document.createElement('span');
        voiceIconSpan.textContent = '🎵 语音';
        
        const durationSpan = document.createElement('span');
        durationSpan.className = 'preview-voice';
        durationSpan.textContent = `${data.duration}秒`;
        
        previewContent = document.createDocumentFragment();
        previewContent.appendChild(voiceIconSpan);
        previewContent.appendChild(durationSpan);
    }
    
    const removeButton = document.createElement('button');
    removeButton.className = 'remove-preview';
    removeButton.textContent = '移除';
    removeButton.onclick = clearMediaPreview;
    
    previewDiv.appendChild(previewContent);
    previewDiv.appendChild(removeButton);
    previewDiv.classList.remove('hidden');
    
    mediaPreview = { data };
}

// 清除媒体预览
function clearMediaPreview() {
    const previewDiv = document.getElementById('mediaPreview');
    if (!previewDiv) return;
    
    // 移除所有子元素，释放资源
    while (previewDiv.firstChild) {
        const child = previewDiv.firstChild;
        // 清理图片资源
        if (child.tagName === 'IMG') {
            child.src = '';
            child.onload = null;
            child.onerror = null;
        }
        // 移除事件监听器
        if (child.tagName === 'BUTTON') {
            child.onclick = null;
        }
        previewDiv.removeChild(child);
    }
    
    previewDiv.classList.add('hidden');
    mediaPreview = null;
}

// 录音相关
let mediaRecorder;
let audioChunks = [];
let isRecording = false;

// 检查浏览器是否支持录音API
function checkRecordingSupport() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('当前浏览器不支持录音功能');
        return false;
    }
    return true;
}

// 切换录音状态
function toggleRecord() {
    if (!checkRecordingSupport()) {
        return;
    }
    
    if (!isRecording) {
        startRecording();
    } else {
        stopRecording();
    }
}

// 开始录音
function startRecording() {
    // 请求录音权限
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
        .then(stream => {
            // 检查是否有音频轨道
            if (stream.getAudioTracks().length === 0) {
                throw new Error('没有可用的音频设备');
            }
            
            // 创建MediaRecorder实例
            if (!MediaRecorder.isTypeSupported('audio/wav')) {
                console.warn('audio/wav格式不支持，使用默认格式');
            }
            
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/wav' });
            audioChunks = [];
            isRecording = true;
            
            const recordBtn = document.getElementById('recordBtn');
            if (recordBtn) {
                recordBtn.classList.add('active');
                recordBtn.textContent = '⏹️';
            }
            
            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunks.push(event.data);
                }
            };
            
            mediaRecorder.onstop = () => {
                const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
                const audioUrl = URL.createObjectURL(audioBlob);
                const duration = Math.round(audioChunks.length * 0.1) || 1;
                
                // 将录音转换为Base64
                const reader = new FileReader();
                reader.onloadend = () => {
                    const base64data = reader.result;
                    showMediaPreview({
                        type: 'voice',
                        content: base64data,
                        duration: duration
                    });
                };
                reader.readAsDataURL(audioBlob);
                
                // 停止音频流
                stream.getTracks().forEach(track => track.stop());
            };
            
            mediaRecorder.onerror = (error) => {
                console.error('录音失败:', error);
                alert('录音失败，请重试');
                stopRecording();
            };
            
            mediaRecorder.start(100); // 每100ms收集一次数据
        })
        .catch(err => {
            console.error('无法访问麦克风:', err);
            let errorMessage = '无法访问麦克风';
            
            // 根据错误类型提供更详细的提示
            if (err.name === 'NotAllowedError') {
                errorMessage = '请开启录音权限后再试\n\n操作步骤:\n1. 打开手机设置\n2. 进入应用管理\n3. 找到当前应用\n4. 开启录音权限';
            } else if (err.name === 'NotFoundError') {
                errorMessage = '未检测到麦克风设备';
            } else if (err.name === 'NotReadableError') {
                errorMessage = '麦克风被其他应用占用';
            }
            
            alert(errorMessage);
        });
}

// 停止录音
function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
    }
    
    isRecording = false;
    const recordBtn = document.getElementById('recordBtn');
    if (recordBtn) {
        recordBtn.classList.remove('active');
        recordBtn.textContent = '🎤';
    }
}

// 输入框元素引用，便于后续移除事件监听器
let inputBoxElement = null;
let inputEventListener = null;

// 设置输入框自动调整高度
function setupAutoResizeInput() {
    const inputBox = document.getElementById('messageInput');
    if (!inputBox) return;
    
    // 保存输入框元素引用
    inputBoxElement = inputBox;
    
    // 初始化输入框高度
    resizeInput(inputBox);
    
    // 移除之前的输入事件监听器，避免重复添加
    if (inputEventListener) {
        inputBox.removeEventListener('input', inputEventListener);
    }
    
    // 移除之前的窗口大小变化监听器，避免重复添加
    if (resizeListener) {
        window.removeEventListener('resize', resizeListener);
    }
    
    // 监听输入事件，自动调整高度
    inputEventListener = () => {
        resizeInput(inputBox);
    };
    inputBox.addEventListener('input', inputEventListener);
    
    // 监听窗口大小变化，重新调整高度
    resizeListener = () => {
        resizeInput(inputBox);
    };
    window.addEventListener('resize', resizeListener);
}

// 调整输入框高度
function resizeInput(input) {
    if (!input) return;
    
    // 重置高度为auto，以便获取正确的scrollHeight
    input.style.height = 'auto';
    
    // 获取max-height值（像素）
    const computedStyle = window.getComputedStyle(input);
    const maxHeight = parseInt(computedStyle.maxHeight);
    
    // 计算新高度，不超过max-height
    const newHeight = Math.min(input.scrollHeight, maxHeight);
    
    // 设置新高度
    input.style.height = newHeight + 'px';
}

// 移除输入框自动调整高度的事件监听器
function removeAutoResizeInput() {
    if (inputBoxElement && inputEventListener) {
        inputBoxElement.removeEventListener('input', inputEventListener);
        inputEventListener = null;
        inputBoxElement = null;
    }
    
    if (resizeListener) {
        window.removeEventListener('resize', resizeListener);
        resizeListener = null;
    }
}

// Protocol Buffers解码函数（使用protobufjs库）
let protoRoot = null;

// 加载Protocol Buffers定义
async function loadProto() {
    try {
        // 注意：在浏览器环境中，需要使用protobufjs的浏览器版本
        // 这里我们使用本地加载的protobufjs库
        if (typeof protobuf !== 'undefined') {
            // 加载messages.proto文件
            const protoContent = await fetch('../proto/messages.proto').then(response => response.text());
            protoRoot = protobuf.parse(protoContent).root;
            console.log('✅ Protocol Buffers定义加载成功');
        } else {
            console.error('❌ protobufjs库未加载');
        }
    } catch (error) {
        console.error('❌ 加载Protocol Buffers定义失败:', error);
    }
}

// 解码消息容器
function decodeMessageContainer(buffer) {
    if (!protoRoot) {
        console.warn('⚠️ Protocol Buffers定义未加载，使用简化版解码');
        // 使用简化版解码，返回null，让调用者处理
        return null;
    }
    
    try {
        const MessageContainer = protoRoot.lookupType('messageApp.MessageContainer');
        const message = MessageContainer.decode(buffer);
        return MessageContainer.toObject(message);
    } catch (error) {
        console.error('❌ 解码消息失败:', error);
        return null;
    }
}

// 初始化时加载Protocol Buffers定义
loadProto();

// 转换Protocol Buffers消息为标准消息格式
function convertProtobufToStandardMessage(protobufMessage) {
    if (protobufMessage.chatMessage) {
        return {
            id: protobufMessage.chatMessage.id,
            senderId: protobufMessage.chatMessage.senderId,
            senderNickname: protobufMessage.chatMessage.senderNickname,
            content: protobufMessage.chatMessage.content,
            messageType: MESSAGE_TYPES[protobufMessage.chatMessage.messageType] || 'text',
            timestamp: protobufMessage.chatMessage.timestamp,
            sent: protobufMessage.chatMessage.sent,
            type: 'message'
        };
    } else if (protobufMessage.systemMessage) {
        return {
            content: protobufMessage.systemMessage.content,
            senderId: protobufMessage.systemMessage.senderId,
            timestamp: protobufMessage.systemMessage.timestamp,
            type: 'system'
        };
    } else if (protobufMessage.errorMessage) {
        return {
            content: protobufMessage.errorMessage.content,
            senderId: protobufMessage.errorMessage.senderId,
            timestamp: protobufMessage.errorMessage.timestamp,
            type: 'error'
        };
    } else if (protobufMessage.loginSuccess) {
        return {
            content: protobufMessage.loginSuccess.content,
            senderId: protobufMessage.loginSuccess.senderId,
            timestamp: protobufMessage.loginSuccess.timestamp,
            avatar: protobufMessage.loginSuccess.avatar,
            type: 'loginSuccess'
        };
    } else if (protobufMessage.loginError) {
        return {
            content: protobufMessage.loginError.content,
            senderId: protobufMessage.loginError.senderId,
            timestamp: protobufMessage.loginError.timestamp,
            type: 'loginError'
        };
    } else if (protobufMessage.groupMembers) {
        return {
            data: {
                groupId: protobufMessage.groupMembers.groupId,
                members: protobufMessage.groupMembers.members.map(member => ({
                    userId: member.userId,
                    nickname: member.nickname,
                    avatar: member.avatar
                }))
            },
            type: 'groupMembers'
        };
    } else if (protobufMessage.recallMessage) {
        return {
            data: {
                groupId: protobufMessage.recallMessage.groupId,
                messageId: protobufMessage.recallMessage.messageId
            },
            senderId: protobufMessage.recallMessage.senderId,
            timestamp: protobufMessage.recallMessage.timestamp,
            type: 'recallMessage'
        };
    }
    return null;
}