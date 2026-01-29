FROM ubuntu:26.04

WORKDIR /app

# 安装依赖
RUN apt-get update && apt-get install -y \
    wget \
    unzip \
    curl \
    git \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# 安装Node.js 18
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# 安装Java 17
RUN apt-get update && apt-get install -y openjdk-17-jdk \
    && rm -rf /var/lib/apt/lists/*

# 安装Android SDK
RUN mkdir -p /opt/android-sdk/cmdline-tools/latest
RUN cd /opt/android-sdk/cmdline-tools \
    && wget -O commandlinetools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
    && unzip commandlinetools.zip \
    && mv cmdline-tools/* latest/ \
    && rm -rf cmdline-tools commandlinetools.zip

# 配置环境变量
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-arm64
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=$ANDROID_HOME
ENV PATH=$PATH:$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/tools

# 接受Android许可证
RUN yes | sdkmanager --licenses || true

# 安装SDK组件
RUN sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"

# 复制项目文件
COPY . .

# 安装项目依赖
RUN npm install

# 构建Android应用
CMD ["cordova", "build", "android"]
