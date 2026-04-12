import smtplib
import json
import os
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

def load_config():
    config_path = os.path.join(os.path.dirname(__file__), '..', 'config.json')
    with open(config_path, 'r', encoding='utf-8') as f:
        return json.load(f)

def send_email(to_email, subject, body):
    """
    Python을 사용하여 메일을 발송하는 함수입니다.
    config.json에 설정된 메일 서버 정보를 사용합니다.
    """
    config = load_config()
    email_config = config.get("email_settings", {})
    
    smtp_server = email_config.get("smtp_server", "smtp.gmail.com")
    smtp_port = email_config.get("smtp_port", 587)
    sender_email = email_config.get("sender_email", "")
    sender_password = email_config.get("sender_password", "") # 앱 비밀번호 등을 사용 권장

    if not sender_email or not sender_password:
        print("Error: 메일 설정(sender_email, sender_password)이 config.json에 없습니다.")
        return False

    # 메달 작성
    msg = MIMEMultipart()
    msg['From'] = sender_email
    msg['To'] = to_email
    msg['Subject'] = subject
    
    msg.attach(MIMEText(body, 'plain'))

    try:
        # SMTP 서버 연결
        server = smtplib.SMTP(smtp_server, smtp_port)
        server.starttls() # TLS 보안 연결
        server.login(sender_email, sender_password)
        
        # 메일 발송
        text = msg.as_string()
        server.sendmail(sender_email, to_email, text)
        server.quit()
        
        print(f"Success: '{to_email}'로 메일을 성공적으로 보냈습니다.")
        return True
    except Exception as e:
        print(f"Error: 메일 발송 중 오류가 발생했습니다: {e}")
        return False

if __name__ == "__main__":
    # 테스트 코드
    test_to = "recipient@example.com"
    test_subject = "EasyDocStation 암호 리셋 테스트"
    test_body = "안녕하세요. 임시 암호 발송 테스트입니다."
    
    # 실제 사용 시 config.json에 정보를 채운 후 실행하세요.
    send_email(test_to, test_subject, test_body)
