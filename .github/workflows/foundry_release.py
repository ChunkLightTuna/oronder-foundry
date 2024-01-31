import http.client
import json
import os
import re
import sys
from html.parser import HTMLParser
from pprint import pprint
from urllib.parse import urlencode

from markdown_it import MarkdownIt

# GitHub Action Secrets
FOUNDRY_PACKAGE_RELEASE_TOKEN = os.environ['FOUNDRY_PACKAGE_RELEASE_TOKEN']
FOUNDRY_USERNAME = os.environ['FOUNDRY_USERNAME']
FOUNDRY_PASSWORD = os.environ['FOUNDRY_PASSWORD']
FOUNDRY_AUTHOR = os.environ['FOUNDRY_AUTHOR']
UPDATE_DISCORD_KEY = os.environ['UPDATE_DISCORD_KEY']

# Build Variables
PROJECT_URL = os.environ['PROJECT_URL']
CHANGES = os.environ['CHANGES']


def push_release(module):
    conn = http.client.HTTPSConnection("api.foundryvtt.com")
    conn.request(
        "POST", "/_api/packages/release_version/",
        headers={
            'Content-Type': 'application/json',
            'Authorization': FOUNDRY_PACKAGE_RELEASE_TOKEN
        },
        body=json.dumps({
            'id': module['id'],
            'release': {
                'version': module['version'],
                'manifest': f"{PROJECT_URL}/releases/download/{module['version']}/module.json",
                'notes': f"{PROJECT_URL}/releases/tag/{module['version']}",
                'compatibility': module['compatibility']
            }
        })
    )
    response_json = json.loads(conn.getresponse().read().decode())
    if response_json['status'] != 'success':
        raise Exception(pprint.pformat(response_json['errors']))


def get_readme_as_html():
    md = MarkdownIt('commonmark', {'html': True}).enable('table')
    with open('./README.md', 'r') as readme_file:
        readme = readme_file.read()
    return md.render(readme)


def get_root():
    conn = http.client.HTTPSConnection('foundryvtt.com')
    conn.request('GET', '/', headers={})
    response = conn.getresponse()
    if response.status != 200:
        raise Exception(response.reason)
    csrf_token = response.getheader('Set-Cookie').split('csrftoken=')[1].split(';')[0].strip()
    csrf_middleware_token = re.search(r'name="csrfmiddlewaretoken" value="([^"]+)"', response.read().decode()).group(1)
    return csrf_token, csrf_middleware_token


def post_auth_login(csrf_token, csrf_middleware_token):
    body = urlencode({
        'csrfmiddlewaretoken': csrf_middleware_token,
        'username': FOUNDRY_USERNAME,
        'password': FOUNDRY_PASSWORD
    })
    headers = {
        'Referer': 'https://foundryvtt.com/',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': f'csrftoken={csrf_token}; privacy-policy-accepted=accepted'
    }
    conn = http.client.HTTPSConnection('foundryvtt.com')
    conn.request('POST', '/auth/login/', body, headers)
    response = conn.getresponse()
    if response.status == 403:
        raise Exception(response.reason)
    cookies = response.getheader('Set-Cookie')

    session_id = cookies.split('sessionid=')[1].split(';')[0].strip()

    return session_id


def extract_errorlist_text(html_string):
    class ErrorListParser(HTMLParser):
        in_errorlist = False
        errorlist_content = []

        def handle_starttag(self, tag, attrs):
            if tag == "ul":
                for attr, value in attrs:
                    if attr == "class" and "errorlist" in value:
                        self.in_errorlist = True

        def handle_endtag(self, tag):
            if tag == "ul" and self.in_errorlist:
                self.in_errorlist = False

        def handle_data(self, data):
            if self.in_errorlist:
                self.errorlist_content.append(data.strip())

    parser = ErrorListParser()
    parser.feed(html_string)
    return parser.errorlist_content


def post_packages_oronder_edit(csrf_token, csrf_middleware_token, session_id, description, module):
    conn = http.client.HTTPSConnection('foundryvtt.com')
    headers = {
        'Referer': 'https://foundryvtt.com/packages/oronder/edit',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': f'csrftoken={csrf_token}; privacy-policy-accepted=accepted; sessionid={session_id}',
    }
    body = urlencode([
        ('username', os.environ.get('FOUNDRY_USERNAME')),
        ('title', module['title']),
        ('description', description),
        ('url', PROJECT_URL),
        ('csrfmiddlewaretoken', csrf_middleware_token),
        ('author', FOUNDRY_AUTHOR),
        ('secret-key', FOUNDRY_PACKAGE_RELEASE_TOKEN),
        ('requires', 1),
        ('tags', 15),
        ('tags', 17)
    ])
    conn.request('POST', '/packages/oronder/edit', body, headers)
    response = conn.getresponse()
    if response.status != 302:
        content = response.read().decode()
        err_msg = f'Update Description Failed\n{extract_errorlist_text(content)}'
        raise Exception(err_msg)


def post_update(version):
    conn = http.client.HTTPSConnection("api.oronder.com")
    conn.request(
        "POST", '/update_discord',
        headers={
            'Content-Type': 'application/json',
            'Authorization': UPDATE_DISCORD_KEY
        },
        body=json.dumps({'version': version, 'changes': CHANGES})
    )
    response = conn.getresponse()
    if response.status != 200:
        content = response.read().decode()
        headers = response.headers.as_string()
        err_msg = f'Failed to send Update Message to Discord\n{content=}\n{headers=}'
        raise Exception(err_msg)


def main():
    with open('./module.json', 'r') as file:
        module_json = json.load(file)
    push_release(module_json)
    print('MODULE POSTED TO REPO')

    csrf_token, csrf_middleware_token = get_root()
    session_id = post_auth_login(csrf_token, csrf_middleware_token)
    readme = get_readme_as_html()
    post_packages_oronder_edit(csrf_token, csrf_middleware_token, session_id, readme, module_json)
    print('REPO DESCRIPTION UPDATED')

    post_update(module_json['version'])
    print('DISCORD NOTIFIED OF NEW RELEASE')


if __name__ == '__main__':
    main()
