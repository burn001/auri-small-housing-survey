import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from config import get_settings


# Type별 subject 와 본문 상단 안내 문구
EMAIL_TYPE_META = {
    "invite": {
        "subject": "[AURI] 소규모(비아파트) 주거 제도개선 전문가 설문 참여 요청",
        "lead_html": (
            "건축공간연구원(AURI)에서는 <strong>다세대·다가구·연립주택 등 소규모 비아파트 주택 "
            "제도 개선 방향</strong>에 대해 전문가 의견을 수렴하는 설문조사를 실시하고 있습니다. "
            "아래 버튼을 클릭하시면 설문 페이지로 이동합니다."
        ),
    },
    "reminder": {
        "subject": "[AURI] 소규모 주거 전문가 설문 응답 추가 요청 (미응답자 재안내)",
        "lead_html": (
            "건축공간연구원에서 진행 중인 <strong>소규모 비아파트 주택 제도개선 전문가 설문</strong>에 "
            "대해 다시 한 번 응답을 부탁드립니다. 앞서 안내드린 설문에 아직 응답하지 않으신 분들께 "
            "재안내 드리는 메일입니다. 짧은 시간에 응답 가능하도록 구성되어 있으니 협조 부탁드립니다."
        ),
    },
    "deadline": {
        "subject": "[AURI] 소규모 주거 전문가 설문 — 마감 임박 안내",
        "lead_html": (
            "<strong>소규모 비아파트 주택 제도개선 전문가 설문</strong>의 응답 마감이 임박했습니다. "
            "아직 응답해 주시지 못한 경우 가능하면 마감 전에 응답해 주시면 큰 도움이 됩니다. "
            "응답 결과는 본 연구의 정책 제언에 직접 활용될 예정입니다."
        ),
    },
    "custom": {
        "subject": "[AURI] 소규모 주거 전문가 설문 안내",
        "lead_html": "",
    },
}


def email_subject_for(email_type: str, override: str | None = None) -> str:
    if override and override.strip():
        return override.strip()
    meta = EMAIL_TYPE_META.get(email_type) or EMAIL_TYPE_META["invite"]
    return meta["subject"]


def _normalize_survey_url(base_url: str, token: str) -> str:
    return f"{(base_url or '').rstrip('/')}/?token={token}"


def _load_template(filename: str = "survey_invite.html") -> str:
    tpl_path = Path(__file__).parent.parent / "templates" / filename
    return tpl_path.read_text(encoding="utf-8")


def render_email(name: str, org: str, survey_url: str, email_type: str = "invite") -> str:
    """invite·reminder·deadline 모두 동일 템플릿 + 상단 lead_html 만 type별로 변경."""
    html = _load_template("survey_invite.html")
    meta = EMAIL_TYPE_META.get(email_type) or EMAIL_TYPE_META["invite"]
    return (html
            .replace("{{name}}", name or "")
            .replace("{{org}}", org or "")
            .replace("{{survey_url}}", survey_url or "")
            .replace("{{lead_html}}", meta["lead_html"]))


def render_completion(name: str, org: str, review_url: str) -> str:
    """응답 제출 직후 자동 발송 — 본인용 확인·수정 링크 포함."""
    html = _load_template("survey_complete.html")
    org_suffix = f" ({org})" if (org or "").strip() else ""
    return (html
            .replace("{{name}}", name or "응답자")
            .replace("{{org}}", org or "")
            .replace("{{org_suffix}}", org_suffix)
            .replace("{{review_url}}", review_url or ""))


def render_custom(name: str, org: str, survey_url: str, body_html: str) -> str:
    """관리자가 작성한 자유 본문에 placeholder 치환. plain text 입력은 줄바꿈을 <br>로 변환."""
    html = body_html or ""
    if "<p" not in html and "<br" not in html and "<div" not in html:
        html = html.replace("\r\n", "\n").replace("\n", "<br>")
    html = (html.replace("{{name}}", name or "")
                .replace("{{org}}", org or "")
                .replace("{{survey_url}}", survey_url or ""))
    return (
        '<div style="font-family:\'Noto Sans KR\',sans-serif;'
        'font-size:14px;line-height:1.7;color:#222;max-width:640px;margin:0 auto;'
        'padding:24px">' + html + '</div>'
    )


def send_email(to_email: str, subject: str, html_body: str) -> bool:
    s = get_settings()
    msg = MIMEMultipart("alternative")
    msg["From"] = f"AURI 소규모 주거 전문가 설문 <{s.GMAIL_USER}>"
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    server = smtplib.SMTP("smtp.gmail.com", 587)
    server.starttls()
    server.login(s.GMAIL_USER, s.GMAIL_APP_PASSWORD)
    server.sendmail(s.GMAIL_USER, to_email, msg.as_string())
    server.quit()
    return True


def send_email_multi(to_list, cc_list=None, *, subject: str, html_body: str) -> bool:
    """다중 To + Cc 발송. Cc 빈 리스트도 허용."""
    s = get_settings()
    cc_list = cc_list or []
    msg = MIMEMultipart("alternative")
    msg["From"] = f"AURI 소규모 주거 전문가 설문 <{s.GMAIL_USER}>"
    msg["To"] = ", ".join(to_list)
    if cc_list:
        msg["Cc"] = ", ".join(cc_list)
    msg["Subject"] = subject
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    server = smtplib.SMTP("smtp.gmail.com", 587)
    server.starttls()
    server.login(s.GMAIL_USER, s.GMAIL_APP_PASSWORD)
    server.sendmail(s.GMAIL_USER, to_list + cc_list, msg.as_string())
    server.quit()
    return True


__all__ = [
    "EMAIL_TYPE_META",
    "email_subject_for",
    "render_email",
    "render_completion",
    "render_custom",
    "send_email",
    "send_email_multi",
    "_normalize_survey_url",
]
