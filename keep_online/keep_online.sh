#! /usr/bin/env bash

# 如果是宿主机, 需要使用你映射的宿主机的路径
file="/root/telebox/temp/keep_online/keep_online.txt"

# 超时(默认为 120 秒)
timeout=120

current_time=$(date +%s)

need_restart=false

if [ ! -f "$file" ]; then
    need_restart=true
else

    last_time=$(cat "$file")
    

    if ! [[ "$last_time" =~ ^[0-9]+$ ]]; then
        need_restart=true
    else

        time_diff=$((current_time - last_time))
        

        if [ $time_diff -gt $timeout ]; then
            need_restart=true
        fi
    fi
fi


if [ "$need_restart" = true ]; then
    echo "$current_time" > "$file"

    # 使用 pm2 重启 telebox. 如果是宿主机直接启动的, 自己改名称. 如果是容器, 自行改成 docker restart telebox 之类的
    pm2 restart telebox
    
    echo "已更新时间戳并重启 telebox 服务。当前时间戳: $current_time"
else
    echo "距离上次时间 $time_diff 秒, 未超过 $timeout 秒，跳过重启"
fi

