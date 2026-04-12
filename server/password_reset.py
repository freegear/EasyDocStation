import random
import string
import json
import os
from email_service import send_email

def generate_random_password(length=10):
    """
    1~0, a~z, A~Z로 구성된 10글자 암호를 생성합니다.
    """
    characters = string.ascii_letters + string.digits
    return ''.join(random.choice(characters) for i in range(length))

def reset_user_password(user_email):
    """
    암호 리셋 프로세스:
    1. 새 암호 생성
    2. 메일 전송
    """
    new_password = generate_random_password()
    
    subject = "[EasyDocStation] 암호 리셋 안내"
    body = f"""
    안녕하세요. EasyDocStation 시스템입니다.
    
    귀하의 계정에 대한 임시 암호가 다음과 같이 발송되었습니다.
    
    임시 암호: {new_password}
    
    로그인 후 반드시 암호를 새로 설정해 주세요.
    감사합니다.
    """
    
    print(f"DEBUG: '{user_email}'을(를) 위한 임시 암호 '{new_password}' 생성됨")
    
    success = send_email(user_email, subject, body)
    
    if success:
        return new_password
    else:
        return None

if __name__ == "__main__":
    # 테스트 실행
    target_user = "test_user_mail@example.com"
    print(f"'{target_user}' 사용자의 암호 리셋을 시도합니다...")
    result = reset_user_password(target_user)
    
    if result:
        print(f"처리 완료. 생성된 암호: {result}")
    else:
        print("처리 실패. config.json의 email_settings를 확인하세요.")
