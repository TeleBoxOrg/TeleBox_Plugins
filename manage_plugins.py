#!/usr/bin/env python3
import os
import re
import sys
import argparse

PLUGINS_DIR = None
HTML_FILE = None

def init_paths(plugins_dir):
    global PLUGINS_DIR, HTML_FILE
    PLUGINS_DIR = os.path.abspath(plugins_dir)
    HTML_FILE = os.path.join(PLUGINS_DIR, 'PLUGIN_SUMMARY.html')
    
    if not os.path.isdir(PLUGINS_DIR):
        print(f'❌ 目录不存在: {PLUGINS_DIR}')
        sys.exit(1)

def get_plugins_from_dir():
    """获取目录中的所有插件（文件夹内包含同名.ts文件）"""
    plugins = []
    for entry in os.listdir(PLUGINS_DIR):
        entry_path = os.path.join(PLUGINS_DIR, entry)
        if os.path.isdir(entry_path) and not entry.startswith('.') and entry not in ['node_modules', 'scripts']:
            ts_file = os.path.join(entry_path, f'{entry}.ts')
            if os.path.exists(ts_file):
                plugins.append(entry)
    return sorted(plugins)

def get_plugins_from_html():
    """从HTML文件中获取已有插件列表"""
    if not os.path.exists(HTML_FILE):
        return []
    with open(HTML_FILE, 'r', encoding='utf-8') as f:
        html = f.read()
    matches = re.findall(r'<h3 id="([^"]+)">', html)
    return sorted(matches)

def read_html():
    with open(HTML_FILE, 'r', encoding='utf-8') as f:
        return f.read()

def write_html(content):
    content = update_plugin_count(content)
    with open(HTML_FILE, 'w', encoding='utf-8') as f:
        f.write(content)

def update_plugin_count(html):
    """自动统计并更新HTML中的插件数量"""
    actual_count = len(re.findall(r'<h3 id="[^"]+">', html))
    html = re.sub(r'共 \d+ 个', f'共 {actual_count} 个', html)
    return html

def add_plugin_to_html(name, description, commands):
    """添加插件到HTML"""
    html = read_html()
    
    # 更新目录
    toc_match = re.search(r'(<div class="toc-list">)([\s\S]*?)(</div>\s*</div>)', html)
    if toc_match:
        existing_links = re.findall(r'<a href="#([^"]+)">', toc_match.group(2))
        all_names = sorted(set(existing_links + [name]))
        new_links = '\n'.join([f'                <a href="#{n}">{n}</a>' for n in all_names])
        html = re.sub(
            r'<div class="toc-list">[\s\S]*?</div>\s*</div>',
            f'<div class="toc-list">\n{new_links}\n            </div>\n        </div>',
            html
        )
    
    # 构建命令HTML
    commands_html = ''
    if commands and commands.strip():
        cmd_parts = []
        for cmd in commands.strip().split('\n'):
            cmd = cmd.strip()
            if cmd:
                parts = cmd.split(' ', 1)
                cmd_name = parts[0]
                cmd_desc = parts[1] if len(parts) > 1 else ''
                cmd_parts.append(f'<code>{cmd_name}</code> {cmd_desc}')
        if cmd_parts:
            commands_html = '<br><br>命令：' + '<br>'.join(cmd_parts)
    
    plugin_html = f'''
<h3 id="{name}">{name}</h3>
<p>{description}{commands_html}</p>
<hr>
'''
    
    # 找到插入位置
    plugins = get_plugins_from_html()
    plugins.append(name)
    plugins = sorted(set(plugins))
    insert_index = plugins.index(name)
    
    if insert_index == len(plugins) - 1:
        # 插入到最后
        html = re.sub(r'(<hr>\s*\n\s*</article>)', f'<hr>\n{plugin_html}\n    </article>', html)
    else:
        # 插入到下一个插件之前
        next_plugin = plugins[insert_index + 1]
        html = re.sub(f'(<h3 id="{next_plugin}">)', f'{plugin_html}\\1', html)
    
    write_html(html)
    print(f'✅ 已添加插件: {name}')

def html_to_text(html_content):
    """将HTML内容转换为纯文本显示"""
    text = html_content
    text = re.sub(r'<br><br>命令：', '\n\n命令：\n', text)
    text = re.sub(r'<br><code>', '\n', text)
    text = re.sub(r'<code>', '', text)
    text = re.sub(r'</code>', '', text)
    text = re.sub(r'&lt;', '<', text)
    text = re.sub(r'&gt;', '>', text)
    text = re.sub(r'&amp;', '&', text)
    return text

def text_to_html(description, commands):
    """将纯文本转换为HTML格式"""
    desc = description.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    if not commands:
        return desc
    
    cmd_parts = []
    for cmd in commands:
        cmd = cmd.strip()
        if cmd:
            parts = cmd.split(' ', 1)
            cmd_name = parts[0]
            cmd_desc = parts[1] if len(parts) > 1 else ''
            cmd_desc = cmd_desc.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
            cmd_parts.append(f'<code>{cmd_name}</code> {cmd_desc}')
    
    if cmd_parts:
        return f'{desc}<br><br>命令：' + '<br>'.join(cmd_parts)
    return desc

def parse_plugin_content(html_content):
    """解析插件HTML内容，返回描述和命令列表"""
    if '<br><br>命令：' in html_content:
        parts = html_content.split('<br><br>命令：', 1)
        desc = parts[0]
        cmd_html = parts[1]
        cmd_html = re.sub(r'<code>', '', cmd_html)
        cmd_html = re.sub(r'</code>', '', cmd_html)
        commands = cmd_html.split('<br>')
    else:
        desc = html_content
        commands = []
    
    desc = desc.replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&')
    commands = [c.replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&') for c in commands]
    return desc, commands

def edit_plugin_in_html(name):
    """编辑HTML中的插件"""
    html = read_html()
    pattern = rf'<h3 id="{re.escape(name)}">{re.escape(name)}</h3>\s*<p>([\s\S]*?)</p>\s*<hr>'
    match = re.search(pattern, html)
    
    if not match:
        print(f'❌ 未找到插件: {name}')
        return None
    
    raw_content = match.group(1)
    desc, commands = parse_plugin_content(raw_content)
    
    return {
        'name': name,
        'description': desc,
        'commands': commands,
        'update': lambda new_desc, new_cmds: _update_plugin(name, text_to_html(new_desc, new_cmds), html, pattern)
    }

def _update_plugin(name, new_content, html, pattern):
    new_html = re.sub(pattern, f'<h3 id="{name}">{name}</h3>\n<p>{new_content}</p>\n<hr>', html)
    write_html(new_html)
    print(f'✅ 已更新插件: {name}')

def delete_plugin_from_html(name):
    """从HTML中删除插件"""
    html = read_html()
    
    # 删除目录链接
    html = re.sub(rf'\s*<a href="#{re.escape(name)}">{re.escape(name)}</a>', '', html)
    
    # 删除插件内容
    html = re.sub(rf'\s*<h3 id="{re.escape(name)}">{re.escape(name)}</h3>\s*<p>[\s\S]*?</p>\s*<hr>', '', html)
    
    write_html(html)
    print(f'✅ 已删除插件: {name}')

def sync_plugins():
    """同步插件"""
    dir_plugins = get_plugins_from_dir()
    html_plugins = get_plugins_from_html()
    
    print(f'\n📁 目录中插件数量: {len(dir_plugins)}')
    print(f'📄 HTML中插件数量: {len(html_plugins)}')
    
    missing = [p for p in dir_plugins if p not in html_plugins]
    extra = [p for p in html_plugins if p not in dir_plugins]
    
    if not missing and not extra:
        print('\n✅ 插件列表已同步，无需更新')
        return
    
    if missing:
        print(f'\n⚠️  以下 {len(missing)} 个插件未添加到 HTML:')
        for i, p in enumerate(missing, 1):
            print(f'   {i}. {p}')
        
        for plugin in missing:
            print(f'\n--- 添加插件: {plugin} ---')
            action = input('添加此插件? (y=添加 / s=跳过 / q=退出): ').strip().lower()
            
            if action == 'q':
                break
            if action == 's':
                continue
            if action in ('y', ''):
                desc = input('输入插件描述: ').strip()
                print('输入命令列表 (每行一个命令，格式: .cmd 说明，输入空行结束):')
                commands = []
                while True:
                    line = input()
                    if not line:
                        break
                    commands.append(line)
                add_plugin_to_html(plugin, desc, '\n'.join(commands))
    
    if extra:
        print(f'\n⚠️  以下 {len(extra)} 个插件在 HTML 中但不在目录中:')
        for i, p in enumerate(extra, 1):
            print(f'   {i}. {p}')

def edit_plugin():
    """编辑插件"""
    plugins = get_plugins_from_html()
    print('\n当前插件列表:')
    for i, p in enumerate(plugins, 1):
        print(f'   {i}. {p}')
    
    inp = input('\n输入插件名称或序号 (q=返回): ').strip()
    if inp.lower() == 'q':
        return
    
    name = inp
    if inp.isdigit():
        num = int(inp)
        if 1 <= num <= len(plugins):
            name = plugins[num - 1]
    
    plugin = edit_plugin_in_html(name)
    if not plugin:
        return
    
    new_desc = plugin['description']
    new_commands = plugin['commands'].copy()
    
    while True:
        print(f'\n══════ 编辑插件: {name} ══════')
        print(f'描述: {new_desc}')
        print('命令:')
        if new_commands:
            for i, cmd in enumerate(new_commands, 1):
                print(f'  {i}. {cmd}')
        else:
            print('  (无命令)')
        
        print('\n操作:')
        print('  d  - 修改描述')
        print('  e <序号> - 编辑指定命令')
        print('  a  - 添加命令')
        print('  r <序号> - 删除指定命令')
        print('  c  - 清空所有命令')
        print('  s  - 保存并返回')
        print('  q  - 放弃修改返回')
        
        action = input('\n选择操作: ').strip().lower()
        
        if action == 'd':
            desc_input = input(f'新描述 (直接回车保持不变): ').strip()
            if desc_input:
                new_desc = desc_input
                print('✅ 描述已更新')
        
        elif action.startswith('e '):
            try:
                idx = int(action[2:]) - 1
                if 0 <= idx < len(new_commands):
                    print(f'当前: {new_commands[idx]}')
                    new_cmd = input('新命令 (格式: .cmd 说明): ').strip()
                    if new_cmd:
                        new_commands[idx] = new_cmd
                        print('✅ 命令已更新')
                else:
                    print('❌ 无效序号')
            except ValueError:
                print('❌ 请输入有效序号')
        
        elif action == 'a':
            new_cmd = input('新命令 (格式: .cmd 说明): ').strip()
            if new_cmd:
                new_commands.append(new_cmd)
                print('✅ 命令已添加')
        
        elif action.startswith('r '):
            try:
                idx = int(action[2:]) - 1
                if 0 <= idx < len(new_commands):
                    removed = new_commands.pop(idx)
                    print(f'✅ 已删除: {removed}')
                else:
                    print('❌ 无效序号')
            except ValueError:
                print('❌ 请输入有效序号')
        
        elif action == 'c':
            if input('确认清空所有命令? (y/n): ').strip().lower() == 'y':
                new_commands = []
                print('✅ 命令已清空')
        
        elif action == 's':
            if new_desc != plugin['description'] or new_commands != plugin['commands']:
                plugin['update'](new_desc, new_commands)
            else:
                print('内容未变更')
            break
        
        elif action == 'q':
            print('已放弃修改')
            break
        
        else:
            print('❌ 无效操作')

def delete_plugin():
    """删除插件"""
    plugins = get_plugins_from_html()
    print('\n当前插件列表:')
    for i, p in enumerate(plugins, 1):
        print(f'   {i}. {p}')
    
    inp = input('\n输入要删除的插件名称或序号 (q=返回): ').strip()
    if inp.lower() == 'q':
        return
    
    name = inp
    if inp.isdigit():
        num = int(inp)
        if 1 <= num <= len(plugins):
            name = plugins[num - 1]
    
    if name not in plugins:
        print(f'❌ 未找到插件: {name}')
        return
    
    confirm = input(f'确认删除插件 "{name}"? (y/n): ').strip().lower()
    if confirm == 'y':
        delete_plugin_from_html(name)
    else:
        print('已取消')

def show_stats():
    """显示统计信息"""
    dir_plugins = get_plugins_from_dir()
    html_plugins = get_plugins_from_html()
    
    print(f'\n📁 目录中插件: {len(dir_plugins)}')
    print(f'📄 HTML中插件: {len(html_plugins)}')
    
    missing = [p for p in dir_plugins if p not in html_plugins]
    extra = [p for p in html_plugins if p not in dir_plugins]
    
    if missing:
        print(f'⚠️  未添加: {", ".join(missing)}')
    if extra:
        print(f'⚠️  多余: {", ".join(extra)}')

def main():
    parser = argparse.ArgumentParser(description='TeleBox 插件管理工具')
    parser.add_argument('directory', nargs='?', help='插件目录路径')
    args = parser.parse_args()
    
    if args.directory:
        plugins_dir = args.directory
    else:
        plugins_dir = input('请输入插件目录路径: ').strip()
        if not plugins_dir:
            print('❌ 未指定目录')
            sys.exit(1)
    
    init_paths(plugins_dir)
    
    print('═══════════════════════════════════════')
    print('       TeleBox 插件管理工具')
    print('═══════════════════════════════════════')
    print(f'📂 插件目录: {PLUGINS_DIR}')
    
    while True:
        print('\n请选择操作:')
        print('  1. 同步插件 (检查并添加新插件)')
        print('  2. 编辑插件')
        print('  3. 删除插件')
        print('  4. 查看统计')
        print('  q. 退出')
        
        choice = input('\n选择: ').strip().lower()
        
        if choice == '1':
            sync_plugins()
        elif choice == '2':
            edit_plugin()
        elif choice == '3':
            delete_plugin()
        elif choice == '4':
            show_stats()
        elif choice == 'q':
            print('\n再见！')
            sys.exit(0)
        else:
            print('无效选择')

if __name__ == '__main__':
    main()
