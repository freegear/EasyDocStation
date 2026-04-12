Description.MD

#1 화면 구성

Slack과 같은 서비스를 구축할 것이다.
화면은 크게 나누면 3개로 나눌 수 있다.

1) 왼쪽은 Team 및 채널 목록을 보여주는 화면
2) 가운데는 선택된 채널의 대화 내용을 보여주는 화면
3) 오른쪽은 GROQ 서비스를 연동하는 것이다.
4) 제일 위에는 타이틀 바와 함께 로그인 한 사람의 정보가 표시된다.

#1.1  왼쪽은 Team 및 채널 목록을 보여주는 화면
- Team 목록
  PostSQL에 있는 team 목록을 보여줌 
- 팀에 해당하는 채널 목록
  PostSQL에 있는 해당 팀의 채널 목록을 보여줌 
- DIRECT MESSAGE 
  PostSQL에 있는 같은 팀의 멤버 목록을 보여 줌


# 1.2 메시지 창 
# 1.2.1 메시지의 등록
메시지가 등록되면 메시지가 계속 밑에서 추가된다.

# 1.2.2 메시지 내용 보기
메시지를 클릭하면 메시지가 있는 메인창을 반으로 나누어서, 
왼쪽은 해당 메시지가 있는 채널의 메시지 목록을 보여주고, 
오른쪽은 해당 메시지의 내용을 보여준다.

메시지 내용은 MD 포멧으로 표시하는 것을 지원한다.

가운데를 반으로 나눈 금은 마우스 드래그로 좌측이나 우측으로 움직일 수 있다.
그리고 그때 움직인것 만큼 컨텐츠를 보여주는 영역의 크기가 변한다.

이떄 Object 파일이 있으면 다음과 같이 하다.
1) 이미지이면 이미지를 image preview로 지정된 크기만큼 보여준다.
2) pdf 파일이면 pdf 파일의 첫 페이지만 보여준다.
다른 object이면, 우선 Object 이름과 다운로드 버튼을 보여준다.

# 1.2.3 게시판 글 등록한 사람의 정보 보여주기
메시지를 등록한 사람의 정보가 해당 정보를 보여준다.
이름과 등록한 사람의 이미지를 같이 보여준다.



# 1.2.4 댓글
댓글을 추가하는데, 댓글도 본 계시판 글과 같이 
글과 함께 Object 파일을 attach 할 수 있다.
이를 위해서 클립 버튼도 추가한다.

댓글도 MD 포멧으로 표시하는 것을 지원한다.

# 1.2.5 계시글과 댓글의 편집

계시글과 댓글이 등록된 후, 작성자가 로그인 된 본인 인 경우, 해당 글을 편집할 수 있는 편집 버튼이 나타난다.
편집 버튼이 눌려지면, 편집 모드로 들어가서, 글을 편집 할 수 있도록 된다.

이떄 Ojbect File로 삭제 버튼을 누르면 삭제 될 수 있다.

# 1.2.6 게시글 삭제

계시글의 작성자로 로그인 된 경우 , 글에 삭제 버튼이 나타난다.
삭제 버튼을 누르면 삭제 된다.
이때 Object 파일이 등록 된 것이 있으면 함께 삭제한다.

댓글도 동일하게 처리한다.

# 1.2.7 댓글의 추가
계시글에 대해서 댓글이 추가된다. 댓글은 게시글의 밑으로 추가해서 들어간다.


# 1.2.8 게시글의 DB추가 
계시글은 Cassandra에 저장한다.
계시글이 삭제되면 Cassandra에 저장된 내용도 삭제한다.




# 2 GROQ 서비스
GROQ 서비스의 Key값은 
........
이다.

# 2.1 GROQ를 제거하고 GEMMA 4.0으로 설치

# 2.1.1 답변의 맨 끝에 Copy로고 버튼을 추가
EasyDoc AgenticAI의 답변에서

AgenticAI가 답변을 하면 답변의 끝에 Copy 로고 버튼을 추가한다.
이 버튼을 클릭하면 답변 전체가 Copy 하여서 클립보드에 저장한다.

다른 기능은 수정하지 말아줘






# 3 타이틀바
EasyDocStation  찾기 [           ][검색 버튼]  Login User Name , 언어 설정, Logout 버튼으로 구성한다.

EasyDocStation 은 바의 왼쪽 끝에 정렬
찾기 부터 Logout 은 바의 오른쪽 끝에 정렬 한다.


# 3.1 언어 설정
한국어, 영어로 한다.

# 3.2 찾기 
# 3.2.1 
[           ][검색 버튼]
찾기 기능을 추가한다.

[     ] 키워드 입력창은 배경은 하얀색, 글자 색은 검은색 으로 해줘

# 3.2.2 
[검색 버튼]을 누르면 
검색 결과 페이지로 이동하고, 
검색된 각 계시글을 표시한다.



# 4 Database
# 4.1  PostgreSQL Database
/Users/kevinim/Desktop/EasyDocStation/Database/PoseSQLDB
에 데이터 베이스 파일을 둔다.


# 4.2 Object File 폴더
/Users/kevinim/Desktop/EasyDocStation/Database/ObjectFile
에 ObjectFile 폴더를 둔다.

# 4.3 config.json 파일
그리고 config.json 파일에
PostgreSQL Database Path : /Users/kevinim/Desktop/EasyDocStation/Database/PoseSQLDB
로 설정한다.

그리고 config.json 파일에
ObjectFile Path : /Users/kevinim/Desktop/EasyDocStation/Database/ObjectFile
로 둔다.

# 4.4 Cassandra 

채널의 글을 올릴 떄 글 자체는 Cassandra에 저장한다.
저장할 때 글을 올린 사람과, 글의 시간을 같이 저장한다.
게시글에 이미지 혹은 객체 파일이 있을 경우, 그 파일은 ObjectFile 폴더에 저장하고, 그 파일의 경로를 Cassandra에 저장한다.
ObjectFile에 저장하는 규칙은 
~ObjectFile/ChannelName/YYYYMMDDHHMMSS/filename1.ext
~ObjectFile/ChannelName/YYYYMMDDHHMMSS/filename2.ext
~ObjectFile/ChannelName/YYYYMMDDHHMMSS/filename2.ext
....
으로 저장된다.



# 5. 채널
Channel은 Chatting으로 하는 것보다는 계시판 형태로 하는 것이 좋다 
문서 관리가 편하기 때문이다. 

권한을 가진 사용자가 글이나 문서  이미지를 올리면 그대로 올라간다. 그리고 그것은 DB에 저장된다.

계시판에 새글이 추가되는 것은 기존 글의 밑으로 추가해서 들어간다.

여기에 파일을 attach하도록 한다.
Attach 가 가능한 파일은 모든 파일이다.
추가 모드는 2가지이다.
1) 클립 아이콘을 추가해서  클립 아이콘 버튼을 누르면 파일 선택 다이얼로그가 나타나고 그 다이얼로그를 통해서 추가한다.
2) 파일을 드래그 앤 드롭으로 텍스트 창에 넣으면 자동으로 추가 된다.

이미지가 추가되면 이미지가 ThumbNail로 보이도록 한다. 
그 크기는 512x512로 보이도록 한다.

이 값은 config.json 파일로 설정 값으로 저장한다.
image preview :
    - width : 512
    - height : 512



##################################################################################################
#6 사용자 관리

사용자 관리를 위해서 PostgreSQL을 사용한다.

사용자는 
ID 
Password
이름
메일주소
이미지 : 사용자 이미지를 추가 할 수 있다. 이미지를 올려도 .
권한  : 사이트 관리자, 팀 관리자, 채널 관리자, 사용자

까지 관리한다.
로그인 할때 로그인 시간을 함께 관리한다.

사이트 관리자는 사이트 관리자가 지정할 수 있다. 
팀 관리자는 팀 관리자 혹은 사이트 관리자가 지정할 수 있다.
채널 관리자는 해당 채널이 속해 있는 팀의 관리자, 혹은 해당 채널의 관리자 혹은 해당 사이트의 관리자가 지정할 수 있다.
채널 멤버의 추가는 채널 관리자만 할 수 있다.

타이틀 바의 사용자 정보를 클릭하면 메뉴 팝업창이 나타난다.
메뉴 팝업창이 나타날 경우 다음과 같은 내용이 나타난다.

사용자 정보 편집
만약 사용자가 사이트관리자 이면 "사이트 관리" 메뉴가 나타난다.
로그아웃

사이트 관리 메뉴를 클릭하면 사이트 관리 페이지로 이동한다.
사용자 관리는 사이트 관리자가 할 수 있다.

6.1 사이트 관리 페이지
사이트 관리 페이지는 
1) 사이트 이름 수정
2) 사용자 추가 / 삭제 
이 가능하다.

위에 

사이트 이름 : [사이트 이름]  

사용자 관리 테이블  [사용자 추가 버튼] 
사용자 ID	이름	메일주소	권한	로그인 시간    삭제 


으로 나타나도록 한다.



6.2 앞으로 서버 실행 방법
서버는 항상 새 터미널을 열어서 실행해야 합니다.

# 포트 3001을 사용 중인 프로세스 종료
lsof -ti :3001 | xargs kill -9

# 터미널 1 — 백엔드 서버
cd ~/Desktop/EasyDocStation/server
npm run dev

# 터미널 2 — 프론트엔드
cd ~/Desktop/EasyDocStation
npm run dev


#################################################################################################
# 7 채널 정보 관리 페이지
채널 정보 바에서  채널 관리 버튼을 추가한다.
채널 관리 버튼은 채널 관리자만 보인다.
채널 관리 버튼을 누르면 다음과 같은 채널 관리 창이 나타난다.
채널 이름 : [채널 이름]
채널 속성 선택 :  공개 채널  비공개 채널
채널 Archive 버튼을 누르면 채널이 Archive 된다.
채널 멤버 테이블  [채널 멤버 추가 버튼] 
멤버 아이디...

이다.

채널 정보 창의 레이아웃과 구성은 팀 정보 관리 페이지와 동일하다.

해당 정보를 postgresql에 저장한다.

# 7.1 채널 멤버 추가
채널 정보 관리 페이지에서 
채널 멤버 테이블 영역에서
채널 멤버 추가 버튼을 누르면 채널 멤버 아이디를 입력할 수 있는 창이나타난다. 
여기에 글자를 입력하면 해당 글자로 시작하는 멤버들의 아이드가 리스트업 되어서 나타나도록 한다.
계속 글자를 입력하면 그만큼 일치하는 멤버들의 아이디만 남게 되고 
그 중에 선택하면 그 멤버가 추가된다.

# 7.2 채널 메시지 추가 

채널에 게시글을 추가한다.
글은 다음과 같다.

게시글이 별도로 제목은 두지 않는다. 
그냥 markup 편집을 지원하고, 

파일 추가를 지원한다.
파일은 이미지파일 , PDF 파일등등 모든 파일을 지원한다.

# 7.3 더블 클릭에의한 채널 정보 관리 페이지
채널 이름을 더블 클릭하면, 채널 정보 관리 페이지가 나타난다.
이는 채널 관리 버튼을 누르는 것과 같다.
다만, 해당 채널의 관리자여야 한다.
만약 관리자가 아니면 아무런 동작을 하지 않는다.



##################################################################################################
# 8 사이트 관리
# 8.1 사이트 정보 / DB 관리 탭

사이트 관리 페이지에 
왼쪽에 버튼 Plane을 둔다.
오른쪽에는 GROQ 창이 나타난다.

# 8.1 사용자 관리 탭
해당 버튼 Plane에 
제일 위애 "전체 사용자 관리" 버튼을 두고 
그 밑에 "DB 관리" 버튼을 둔다.
"Display 설정" 버튼을 둔다.

# 8.2 DB 관리 탭
DB 관리 탭은 
-1. 현재 POSTSQL DB의 위치와 크기
-2. Object File 폴더의 위치가 크기
를 알려준다

# 8.3 Display 설정 
Display 설정 섹션을 두고
config.json에 설정된 
image preview :
    - width : 512
    - height : 512
값을 표시한다.
그리고 값을 설정할 수 있도록 한다.

Display 설정 섹션의 제일 위에 "저장" 버튼을 두고 버튼이 눌려지면 config.json에 해당 값이 들어간다.

############################################################
# 9 Team 관리

# 9.1 Team 추가

EasyDocStation 메인 창에서
Teams 칸 제일 밑에 "팀 추가" 버튼을 추가한다.

해당 버튼을 누르면 Team 추가 창이 나타난다.

창 이름은 "Team 추가" 
항목은

Team 이름   : 
Team 관리자 :
Team 설명 : 
   MD 포멧으로 설정가능한 편집 영역을 추가함. 팀의 목적을 설명한다.

버튼으로 저장 , 취소 
가 나타난다.

추가 되면 Team 이름이 추가되어서 Team 목록에 나타난다.

팀 이름과 관리자는 PostgreSQL에 저장한다.

Team 관리자 *(최소 1명) 칸에 직접 텍스트로 타입을 해서 추가할 수있도록 한다.
Team 멤버 추가도 관리자 추가 와 같은 방식으로 한다.

# 9.1.2 같은 Team 이름이 있으면 추가되지 않도록 한다.


# 9.2 Team 삭제

팀 이름을 두번 클릭하면, Team 정보 창이 나타난다.

Team 이름   : 
Team 관리자 : 
- 팀 관리자는 최소 1명 이상이 지정된다.
- 관리자 추가 버튼은 크게 만들어서 쉽게 클릭되도록 만든다.
Team 설명  : 
   MD 포멧으로 설정가능한 편집 영역을 추가함. 팀의 목적을 설명한다.
   화면에 보이는 모드는 편집과 미리보기 모드이다.
   디폴트로 미리 보기 모드로한다.

버튼으로 삭제, 저장 , 취소 



삭제는 팀을 삭제한다. 
삭제하면 해당 팀에 속한 채널들도 함께 삭제된다.
채널에 저장된 값들도 모두 삭제된다.

저장는 팀의 이름과 관리자를 PostgreSQL에 저장한다.

취소는 아무것도 하지 않는다. 그냥 창만 닫는다.

# 9.3 팀 정보 관리
팀 정보 창이 나타나면, DB에 물어봐서 해당 팀의 관리자가 정보 창에 모두 나타나도록 표시한다.


# 9.4 팀 이름 더블 클릭하여서 팀 정보 설정 창 불러오기
팀 이름을 더블클릭하면, 해당 팀의 관리자이면, 팀 정보 설정 창이 나타난다.
관리자가 아니면, 아무것도 하지 않는다.



###################################################################################
# 10 Channel 관리
# 10.1 Channel 추가
Channels 밑에 Channel 추가 버튼이 있고, 이 버튼을 누르면, 채널 추가 창이 나타난다

"채널 추가"
채널 이름   : 
채널 종류   : 공개 채널, 비공개 채널
채널 관리자 : 
채널 멤버   :  멤버 추가 버튼

저장 , 취소 버튼이 나타난다.

저장 버튼을 누르면 채널 이름이 Channels 목록에 나타난다.
추가된 채널은 CHNNAELS와 + 채널 추가 사이에 나타난다.
여러 채널일 경우 오름차순으로 정리해서 나타나도록 한다.

# 10.2 채널 관리

채널 이름을 더블 클릭하면, 
채널 관리 창이 나타난다.

"채널 관리"
채널 이름
채널 종류 : 공개 채널, 비공개 채널
채널 관리자 :
채널 멤버 : 
채널 메시지 수 :
채널 파일 수 :
채널 데이터 크기 :

삭제 , 저장 , 취소  버튼을 둔다.

삭제는 채널을 삭제하는 것이다 이 버튼을 누르면 채널이 삭제된다. 
단 그전에 메시지 창을 띄워서 다시 무물어본다.
"정말 이 채널을 삭제하시겠습니까?  삭제 되면 복구할 수 없습니다."
[ 채널 이름 ]을 입력하고 확인 버튼을 누르면 입력한 채널 이름과 채널 이름이 동일하면 채널이 삭제된다.

저장 버튼은 채널의 이름이 이전과 다른 이름이면 채널 이름을 변경한다. 
관리자는 PostgreSQL에 저장한다.



# 11. Local-S3 Mocking 서비스 아키텍처 설계 및 구현

이 서비스는 AWS S3의 역할을 자체 API 서버(Local File Service)와 로컬 디렉토리가 분담하여 수행합니다.
이와 같은 서비스를 지원하는 서버를 만들어주고, EasyDoc이 실행할 때에 자동으로 실행되도록 한다.
Local File을 저장하는 폴더는 

config.json 파일에서 "Object File 폴더" 정보를 기반으로 한다.


1. 주요 구성 요소
클라이언트 (Web/Mobile): 파일을 선택하고 업로드/다운로드하는 사용자 인터페이스. S3 SDK 대신 표준 HTTP 클라이언트(Axios, Fetch 등)를 사용합니다.
API 서버 (Gateway & File Service): S3의 Presigned URL 생성 기능과 Object Storage 기능을 모두 모방하는 중앙 서버입니다.
로컬 파일 시스템 (Storage): 실제 파일이 저장되는 서버의 하드 디스크 내 특정 폴더입니다.

2. 핵심 구현 매커니즘: Mock Presigned URL
AWS는 자체 비밀키로 URL을 서명합니다. 우리는 자체 JWT(JSON Web Token) 또는 HMAC(Hash-based Message Authentication Code)를 사용하여 이를 모방합니다.

서버가 생성할 Mock Presigned URL 예시:
https://localhost:5173/files/download/mock-file-key?token=eyJhbGciOiJIUzI1NiJ9...&expires=1678888888

mock-file-key: 파일이 저장된 로컬 경로를 유추할 수 있는 고유 키.
token: 서버만 아는 비밀키로 서명된 JWT. 이 안에 file_id, user_id, allowed_action(READ/WRITE), expires_at 정보를 담습니다.
expires: URL의 만료 시간 (보안성 확보).

3. 파일 업로드 흐름 (S3 Mocking)
사용자가 파일을 업로드하는 전체 프로세스입니다.

단계 1: Mock Presigned URL 요청 (Client -> Server)
사용자가 클라이언트에서 파일을 선택합니다. (예: image.png)
클라이언트는 서버의 API(POST /api/files/get-upload-url)에 파일 메타데이터(파일명, 타입)를 보냅니다.

단계 2: Mock Presigned URL 생성 및 레코드 생성 (Server)
서버는 PostgreSQL의 attachments 테이블에 상태를 'PENDING'으로 하여 파일 레코드를 생성하고 unique ID(file_uuid)를 발급합니다.
서버는 file_uuid, action='WRITE', expires=15m 정보를 담은 임시 토큰을 비밀키로 생성합니다.
서버는 이 토큰을 포함한 Mock Presigned URL을 구성하여 클라이언트에 반환합니다.

단계 3: 로컬로 파일 업로드 (Client -> Server)
클라이언트는 전달받은 Mock Presigned URL로 실제 파일 데이터를 PUT 또는 POST 요청으로 보냅니다. 이 요청은 여전히 S3가 아닌 우리 서버로 옵니다.

단계 4: 토큰 검증 및 로컬 저장 (Server)
서버의 파일 업로드 핸들러는 URL의 토큰을 먼저 해독하고 검증합니다.
서명이 유효한가?
만료되지 않았는가?
이 토큰이 'WRITE' 권한을 가지고 있는가?
검증이 성공하면, 서버는 요청 스트림에서 파일 데이터를 읽어 로컬 디렉토리 (예: /var/www/easydoc/uploads/file_uuid.png)에 직접 저장합니다.
저장이 완료되면 PostgreSQL의 해당 파일 레코드 상태를 'COMPLETED'로 업데이트합니다.

4. 파일 다운로드 흐름 (S3 Mocking)
파일을 안전하게 다운로드하거나 웹 페이지에 표시할 때의 프로세스입니다.

단계 1: Mock Presigned URL 요청 (Client -> Server)
클라이언트가 특정 파일의 다운로드 URL을 요청합니다. (GET /api/files/{file_uuid}/get-download-url)

단계 2: Mock Presigned URL 생성 (Server)
서버는 현재 사용자의 권한을 체크한 뒤, 다운로드용 Mock Presigned URL을 생성합니다.
토큰 내용: file_uuid, action='READ', expires=30m

단계 3: 파일 요청 (Client -> Server)
클라이언트는 전달받은 URL을 <a> 태그의 href로 사용하거나 <img> 태그의 src로 사용하여 파일을 요청합니다.

단계 4: 토큰 검증 및 파일 스트리밍 (Server)
서버는 토큰을 검증합니다 (action='READ').
검증 성공 시, 로컬 파일 시스템에서 해당 파일을 찾아 읽습니다.

서버는 HTTP 응답 헤더(Content-Type, Content-Disposition)를 설정하고, 파일 데이터를 클라이언트로 스트리밍(streaming)하여 보냅니다.

# 12 채널에 메시지 등록

현재 채널의 메시지를 계시글로 등록하는 것은 
채널 내용의 계시판 밑에 글을 넣고 확인 버튼 (비행기 모양)을 누르면된다.

단, 제목은 따로 없으며 본문만 등록한다. 
파일을 함께 등록할 경우 파일은  Local-S3 Mocking 서비스를 이용해서 각각 등록하고

계시되는 메시지에 글 과 함께 Cassendra 에 저장한다.



# 13 RAG 학습

# 13.1 RAG 학습 옵션 설정 추가

# 13.1.1 RAG 학습 버튼 추가

사이트 관리에서 
사용자 관리 
DB 관리
Display 설정 

밑으로 

RAG 학습 설정 버튼을 추가한다.

이 버튼을 클릭하면 RAG 학습 옵션 설정 페이지를 보여준다.

# 13.2 RAG 학습 옵션 설정 페이지

# 13.2.1 학습 시간 / 주기 설정

학습 시간을 설정할 수 있다.
- 1) 매일 설정한 시간에 전날 올라온 모든 글을 학습 한다.
     시간은 설정할 수 있다.
- 2) 글이 올라오는 즉시 학습한다.
- 3) 관리자가 "학습 시작" 이라는 버튼을 누르면 학습을 시작한다.
    "학습 시작" 버튼은 학습 시간 / 주기 설정 section에 있다.


# 13.2.2 config.json에 저장

config.json 파일에 
RAG 학습 옵션 : 
    학습 시간 / 주기 설정 : 
          매일 설정한 시간에 학습 , 02:00
          글이 올라오는 즉시 학습
          수동 학습 
에 맞추어서 저장하여줘

# 13.2.3 데이터베이스 및 오브젝트 관리 페이지에

lancedb 폴더를 설정하는 카드를 추가해줘

lancedb 폴더
/Users/kevinim/Desktop/EasyDocStation/Database/LanceDB

로 추가해줘

해당 데이터는 config.json에 

lancedb Database Path : /Users/kevinim/Desktop/EasyDocStation/Database/LanceDB

로 추가해주고

EasyDocStation이 로딩 될떄에 읽어들여서 설정하고
저장 버튼을 누르면 새로운 값으로 업데이트 해줘

# 13.2.4 LanceDB 설치

pip install lancedb tantivy
# Gemma 4 임베딩을 위해 함께 설치
pip install sentence-transformers


# 13.2.5  lancedb를 초기화 

##############
#  lancedb를 초기화 시켜줘
import lancedb

uri = "./lancedb_data"
db = lancedb.connect(uri)

# 최초 생성 시에만 실행
data = [{"vector": [0.1] * 1024, "text": "init", "metadata": {"source": "system"}}]
table = db.create_table("my_rag_table", data=data, mode="overwrite")
##############

# 13.2.6 RAG 학습 옵션 설정 
RAG 학습 옵션 설정 페이지에

vector size : 256 , 512 , 1024 , 1536 , 2048 , 4096 , 8192 을 선택 할 수 있게 한다

이 값은 config.json 파일에 

rag vector size : 1024

로 추가해주고

EasyDocStation이 로딩 될떄에 읽어들여서 설정하고
저장 버튼을 누르면 새로운 값으로 업데이트 해줘

다른 페이지나 다른 기능은 수정하지 말아줘


설정 저장 버튼을 누르면 아래 코드를 실행해줘

네, 변경 가능합니다. mode="overwrite"로 테이블을 재생성하면 됩니다.
현재 크기 1024는 초기 데이터 [0.1] * 1024에서 자동으로 결정된 것입니다. 원하는 크기로 바꾸려면:


python3 - <<'EOF'
import lancedb

uri = "/Users/kevinim/Desktop/EasyDocStation/Database/LanceDB"
db = lancedb.connect(uri)

DIM = 768  # 원하는 크기로 변경 (예: 384, 768, 1024, 1536 등)

data = [{"vector": [0.1] * DIM, "text": "init", "metadata": {"source": "system"}}]
table = db.create_table("my_rag_table", data=data, mode="overwrite")
print(f"벡터 크기 {DIM}으로 재설정 완료")
EOF


# 13.2.7 청크 크기 설정
RAG 학습 옵션 설정 페이지에

한 청크당 글자 수        : chunk_size=800,      # 한 청크당 글자 수
청크 간 중복 영역 글자 수 : chunk_overlap=100,   # 청크 간 중복 영역 글자 수

을 설정하는 기능을 추가한다.

config.json파일에 rag.chunk_size 와 rag.chunk_overlap 을 추가하고

EasyDocStation이 로딩 될떄에 읽어들여서 설정하고
저장 버튼을 누르면 새로운 값으로 업데이트 해줘

다른 기능은 수정하지 말아줘




# 13.3 RAG 학습

# 13.3.1 PDF 파일 학습

PDF를 학습하려면 아래 코드를 사용해서 추가함. 

################# 
from pypdf import PdfReader

def load_pdf(file_path):
    reader = PdfReader(file_path)
    text = ""
    for page in reader.pages:
        text += page.extract_text() + "\n"
    return text

raw_text = load_pdf("your_document.pdf")

from langchain_text_splitters import RecursiveCharacterTextSplitter

text_splitter = RecursiveCharacterTextSplitter(
    chunk_size=config.rag.chunk_size,      # 한 청크당 글자 수
    chunk_overlap=config.rag.chunk_overlap,   # 앞뒤 청크 간 겹치는 부분 (문맥 유지)
    length_function=len,
)

chunks = text_splitter.split_text(raw_text)

# embed_model은 이전 답변에서 설정한 BGE-M3 등을 사용
vectors = embed_model.encode(chunks)

records = []
for i, (text, vector) in enumerate(zip(chunks, vectors)):
    records.append({
        "vector": vector,
        "text": text,
        "metadata": {"source": "my_pdf", "page": i}
    })

table.add(records)

#################

# 13.3.2 계시글의 학습 설정

만약 계시글이 올라오고, 학습 옵션에서 "글이 올라오는 즉시 학습" 이 선택되어 있다면
즉 "immediate" 이면, 

즉시 학습한다.
게시글은 text로 학습한다.
첨부된 파일중 PDF는  13.3.1 PDF 파일 학습 에 따라서학습한다.

매일 설정한 시간에 학습 이면
해당 시간에 이전날 올라온 모든 글과 데이터를 학습한다.

수동 학습 (관리자 실행) 이면, 
관리자가 "학습 시작" 버튼을 누르면 학습을 시작한다.
이전 학습 이후에 올라온 모든 글을 학습니다.

EasyDocStation이 로드될 때에 config.json을 읽어들여서 설정하거나, 
저장 버튼을 누르면 새로운 값으로 업데이트 해줘

다른 부분은 수정하지 말아줘


# 13.3.3 Text 학습 코드

##########
from langchain_text_splitters import RecursiveCharacterTextSplitter

# 1. 원본 텍스트 준비
raw_text = {게시글 내용}

# 2. 텍스트 분할기 설정
text_splitter = RecursiveCharacterTextSplitter(
    chunk_size=config.rag.chunk_size,
    chunk_overlap=config.rag.chunk_overlap,
    separators=["\n\n", "\n", ".", " "] # 단락 -> 줄바꿈 -> 마침표 순으로 분할 시도
)
chunks = text_splitter.split_text(raw_text)

from sentence_transformers import SentenceTransformer

# 모델 로드 (Mac GPU/MPS 가속 활용)
embed_model = SentenceTransformer('BAAI/bge-m3', device='mps')

# 텍스트를 벡터로 변환
vectors = embed_model.encode(chunks)

import lancedb

db = lancedb.connect("./lancedb_data")
table = db.open_table("my_rag_table") # 기존에 만든 테이블 열기

# 저장할 데이터 형식 구성
data_to_save = []
for i, (text, vector) in enumerate(zip(chunks, vectors)):
    data_to_save.append({
        "vector": vector,
        "text": text,
        "metadata": {"chunk_id": i, "type": "manual_text"}
    })

# DB에 추가 (이 순간 '학습' 완료)
table.add(data_to_save)




#########


#################################################################################
# Error

# E.1 Display 설정 사라진 사전

사이트 관리 에서

사용자 관리 
DB 관리
Display 설정 
RAG 학습 설정

이 있어야 하는데 DB관리가 없어지고
DB 관리가 Display 관리로 바뀌었다.

현재의 Display 관리를 DB 관리로 바꾸어주고
Display 관리는 추가해줘

Display 관리에 추가될 내용은 

config.json 파일에 저장되어있는 imagePreview 내용이다.

  "imagePreview": {
    "width": 378,
    "height": 378
  },

EasyDocStation을 실행할 떄 불러 들여서 설정하고, 
저장 버튼을 누르면 설정된 값이 저장되도록 한다.

다른 부분은 수정하지 말아줘


# E.2 RAG 학습 여부와 결과 확인

import lancedb

db = lancedb.connect("./lancedb_data")
table = db.open_table("my_rag_table")

# 1. 전체 데이터 개수 확인
print(f"현재 총 저장된 청크 수: {len(table)}")

# 2. 가장 최근에 추가된 데이터 5개 확인
# LanceDB는 추가된 순서대로 저장되므로 마지막 레코드를 확인하면 됩니다.
latest_data = table.to_pandas().tail(5)
print("--- 최신 추가 데이터 목록 ---")
print(latest_data[['text', 'metadata']])


# E.3 업로드시 즉시 RAG 수행
