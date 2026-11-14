export const userGuideSections = [
    {
        id: 'basic', title: '기본 조작',
        pages: [
            {
                id: 'basics', title: '화면과 기본 조작',
                content: `
                    <p>처음 사용한다면 기본 조작에서 화면 살펴보기, 오브젝트 추가, 변환, 저장 순서로 익혀보세요. 좌표계·피벗, 정밀 모델링과 텍스처 편집은 고급 조작에서 다룹니다.</p>
                    <p>가운데 3D 화면에서 모델을 확인하고, 씬 목록과 속성 패널에서 편집할 대상을 선택하고 값을 조절합니다.</p>
                    <h3>화면 구성</h3>
                    <ul>
                        <li><strong>상단 메뉴:</strong> 프로젝트 생성·열기·저장, 내보내기, 사용설명서를 엽니다.</li>
                        <li><strong>오브젝트 도구:</strong> <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE061;</span>블록, <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE5C6;</span>아이템, <span class="user-guide-icon user-guide-head-icon" aria-hidden="true"></span>헤드, <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE198;</span>텍스트를 추가하고 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE1D3;</span>헤드 페인터와 <span class="user-guide-icon user-guide-menu-icon" aria-hidden="true">≡</span>설정을 엽니다.</li>
                        <li><strong>변환·편집 도구:</strong> <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE121;</span>이동·<span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE149;</span>회전·<span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE2EC;</span>크기 조절, 그룹, 복제, 삭제, 실행 취소를 사용합니다.</li>
                        <li><strong>씬 오브젝트:</strong> 오브젝트와 그룹의 계층, 이름, 표시 상태를 관리합니다.</li>
                        <li><strong>속성 패널:</strong> 선택한 오브젝트의 속성을 편집합니다. 선택을 해제하면 프로젝트 세부 정보가 표시됩니다.</li>
                    </ul>
                    <h3>카메라 조작</h3>
                    <p>빈 공간에서 마우스 왼쪽 버튼을 누르고 드래그하면 시점을 회전합니다. 오른쪽 버튼을 누르고 드래그하면 화면을 평행 이동하고, 휠로 확대·축소합니다.</p>
                    <p>선택한 모델을 가까이 보려면 <kbd>F</kbd>를 누릅니다. 설정 또는 3D 화면의 오른쪽 클릭 메뉴에서 원근·직교 카메라를 바꿀 수 있습니다.</p>
                    <h3>선택과 다중 선택</h3>
                    <p>오브젝트를 클릭해 선택하고, <kbd>Shift</kbd>를 누른 채 클릭해 선택을 추가하거나 해제합니다. 그룹 안의 개별 오브젝트를 선택하려면 <kbd>Ctrl</kbd>을 누른 채 클릭합니다.</p>
                    <p><kbd>Ctrl</kbd>을 누른 채 3D 화면을 드래그하면 영역을 선택합니다. <kbd>Ctrl + Shift</kbd> 드래그는 그룹을 무시하고 오브젝트를 선택합니다. 빈 공간을 클릭하면 선택이 해제됩니다.</p>
                    <p><kbd>Ctrl + A</kbd>는 전체 선택, <kbd>Ctrl + Shift + A</kbd>는 그룹을 제외한 오브젝트 선택입니다.</p>`
            },
            {
                id: 'panels', title: '패널 조작',
                content: `
                    <p>씬 오브젝트, 프로젝트 세부 정보, 헤드 페인터, 헤드 텍스처 아틀라스를 작업하기 편한 위치로 배치할 수 있습니다.</p>
                    <h3>패널 이동과 좌우 배치</h3>
                    <ol>
                        <li>이동할 패널의 제목 부분을 누른 채 드래그합니다.</li>
                        <li>왼쪽 또는 오른쪽 패널 영역으로 옮깁니다. 비어 있는 쪽은 화면 가장자리로 가져갑니다.</li>
                        <li>배치 미리보기가 원하는 위치에 표시되면 버튼을 놓습니다.</li>
                    </ol>
                    <h3>순서 변경과 탭으로 묶기</h3>
                    <p>다른 패널의 위·아래로 끌어 순서를 바꿉니다. 다른 패널의 제목 위에 놓으면 같은 공간을 사용하는 탭으로 묶입니다. 탭 제목을 클릭해 표시할 패널을 바꾸고, 제목을 다시 드래그해 분리합니다.</p>
                    <h3>크기 조절</h3>
                    <p>3D 화면과 사이드바 사이의 세로 경계선을 좌우로 끌면 너비가 바뀝니다. 패널 사이의 가로 경계선을 위아래로 끌면 높이를 조절할 수 있습니다.</p>
                    <h3>접기와 다시 펼치기</h3>
                    <p>패널 제목을 클릭하면 접거나 펼칩니다. 탭으로 묶인 경우 현재 선택된 탭을 다시 클릭하면 묶음 전체를 접습니다. 사이드바를 화면 가장자리로 밀어 접었다면 경계선을 화면 안쪽으로 끌어 다시 펼칠 수 있습니다.</p>
                    <h3>배치 유지</h3>
                    <p>패널의 배치와 크기는 현재 앱의 설정에 저장됩니다. 헤드 페인터처럼 특정 기능을 열었을 때만 나타나는 패널도 있습니다.</p>`
            },
            {
                id: 'objects', title: '오브젝트 추가와 속성',
                content: `
                    <p>블록·아이템·헤드·텍스트 디스플레이를 조합해 모델을 만듭니다. 선택한 오브젝트에 따라 속성 패널에서 편집할 수 있는 항목이 달라집니다.</p>
                    <h3>오브젝트 추가</h3>
                    <ol>
                        <li>빈 공간을 클릭해 기존 선택을 해제합니다.</li>
                        <li>오브젝트 도구에서 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE061;</span>블록 또는 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE5C6;</span>아이템을 열고, 이름을 검색해 원하는 항목을 클릭합니다.</li>
                        <li><span class="user-guide-icon user-guide-head-icon" aria-hidden="true"></span>헤드나 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE198;</span>텍스트는 해당 아이콘을 눌러 추가합니다.</li>
                    </ol>
                    <h3>선택한 오브젝트 교체</h3>
                    <p>오브젝트를 선택한 상태에서 블록·아이템·헤드·텍스트를 고르면 선택한 대상이 교체됩니다. 새 오브젝트를 추가하려면 먼저 선택을 해제하세요. 설정의 오브젝트 교체 모드에서 보이는 크기 유지 여부를 바꿀 수 있습니다.</p>
                    <h3>블록과 아이템 속성</h3>
                    <p>속성 패널에서 블록의 방향·상태와 아이템의 표시 유형을 조절합니다. 여러 대상을 선택했다면 편집할 대상이 맞는지 씬 목록에서 함께 확인하세요.</p>
                    <h3>텍스트 속성</h3>
                    <p>텍스트를 선택하면 내용, 글꼴, 정렬, 색상, 투명도, 그림자와 배경 등을 편집할 수 있습니다. 내용 유형과 페이지를 확인한 뒤 필요한 값을 바꿉니다.</p>
                    <h3>밝기와 NBT</h3>
                    <p>오브젝트 속성에서 개별 밝기와 NBT를 편집합니다. 프로젝트 세부 정보의 전역 밝기는 전체 모델의 밝기를 조절할 때 사용합니다. NBT를 직접 입력했다면 내보낸 결과도 확인하세요.</p>`
            },
            {
                id: 'transforms', title: '이동·회전·크기 조절',
                content: `
                    <p>대상을 선택하면 변환 도구로 위치와 모양을 조절할 수 있습니다. 화면의 축 손잡이를 드래그하거나 속성의 변환 값을 직접 입력합니다.</p>
                    <h3>기본 변환 도구</h3>
                    <table><thead><tr><th>도구</th><th>기본 키</th><th>사용 방법</th></tr></thead><tbody>
                        <tr><td><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE121;</span>이동</td><td><kbd>T</kbd></td><td>축 또는 평면 손잡이를 드래그해 위치를 옮깁니다.</td></tr>
                        <tr><td><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE149;</span>회전</td><td><kbd>R</kbd></td><td>회전 손잡이를 드래그해 각도를 바꿉니다.</td></tr>
                        <tr><td><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE2EC;</span>크기</td><td><kbd>S</kbd></td><td>크기 손잡이를 드래그해 선택한 축의 크기를 바꿉니다.</td></tr>
                    </tbody></table>
                    <h3>기본 작업 순서</h3>
                    <ol>
                        <li>3D 화면이나 씬 목록에서 편집할 대상을 선택합니다.</li>
                        <li>이동·회전·크기 버튼을 누르거나 해당 단축키로 도구를 선택합니다.</li>
                        <li>화면의 축 손잡이를 드래그하고 결과를 확인합니다. 잘못 조절했다면 <kbd>Ctrl + Z</kbd>로 되돌립니다.</li>
                    </ol>
                    <h3>수치 입력</h3>
                    <p>정확한 값이 필요하면 속성 패널의 변환 입력란을 사용합니다. 여러 대상을 편집할 때는 먼저 선택 범위를 확인하세요. 좌표계와 피벗, 드래그 간격은 고급 조작의 정밀 변환과 모델링에서 설명합니다.</p>`
            },
            {
                id: 'scene', title: '씬과 그룹 관리',
                content: `
                    <p>씬 목록은 모델의 구성과 계층을 보여줍니다. 관련 오브젝트를 그룹으로 묶으면 함께 이동하고 관리하기 편합니다.</p>
                    <h3>씬 목록과 이름 변경</h3>
                    <p>목록의 항목을 클릭해 선택합니다. <kbd>Shift</kbd> 또는 <kbd>Ctrl</kbd>을 누른 채 클릭하면 선택을 추가·해제합니다. 항목을 선택한 뒤 <kbd>F2</kbd>를 눌러 이름을 바꾸고 <kbd>Enter</kbd>로 확정합니다.</p>
                    <h3>표시와 숨기기</h3>
                    <p>항목 오른쪽의 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE0BA;</span>표시 / <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE0BB;</span>숨김 아이콘으로 오브젝트나 그룹을 숨기고 다시 표시합니다. 모델이 보이지 않을 때는 상위 그룹의 표시 상태도 확인하세요.</p>
                    <h3>그룹 생성과 해제</h3>
                    <p>함께 다룰 대상을 선택한 뒤 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE464;</span>그룹 생성·해제 버튼 또는 <kbd>G</kbd>로 그룹을 만듭니다. 그룹 생성·해제 동작은 현재 선택에 따라 달라집니다. 그룹 해제만 실행하려면 <kbd>Ctrl + G</kbd>를 사용합니다.</p>
                    <h3>계층과 순서 변경</h3>
                    <p>씬 항목을 드래그해 순서를 바꾸거나 그룹으로 옮깁니다. 드롭 위치 표시를 보고 놓은 뒤 그룹을 펼쳐 결과를 확인합니다.</p>
                    <h3>복제·복사·삭제</h3>
                    <p><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE09E;</span>복제 버튼 또는 <kbd>D</kbd>로 선택한 대상을 복제합니다. <kbd>Ctrl + C</kbd>와 <kbd>Ctrl + V</kbd>로 복사·붙여넣기하고, <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE18E;</span>삭제 버튼 또는 <kbd>Delete</kbd>, <kbd>Backspace</kbd>로 삭제합니다.</p>
                    <h3>실행 취소와 다시 실행</h3>
                    <p>잘못 편집했다면 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE19B;</span>실행 취소 버튼 또는 <kbd>Ctrl + Z</kbd>로 실행 취소합니다. <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE143;</span>다시 실행 버튼 또는 <kbd>Ctrl + Shift + Z</kbd>, <kbd>Ctrl + Y</kbd>로 다시 실행합니다.</p>`
            },
            {
                id: 'files', title: '프로젝트 저장과 내보내기',
                content: `
                    <p>편집을 이어갈 파일은 프로젝트로 저장하고, Minecraft에서 사용할 결과는 소환 명령어로 내보냅니다.</p>
                    <h3>프로젝트 열기와 병합</h3>
                    <p>파일 → <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE247;</span>프로젝트 열기 또는 <kbd>Ctrl + O</kbd>로 파일을 엽니다. 현재 프로젝트에 다른 파일의 내용을 더하려면 파일을 창으로 드래그한 뒤 프로젝트 합치기를 선택합니다. 열 수 있는 형식은 <code>.pde</code>, <code>.bdengine</code>, <code>.mcfunction</code>입니다.</p>
                    <h3>새 프로젝트와 프로젝트 탭</h3>
                    <p>파일 → <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE0C9;</span>새 프로젝트 또는 <kbd>Ctrl + N</kbd>으로 현재 프로젝트를 새로 시작합니다. 저장 여부를 확인한 뒤 진행하세요. 현재 작업을 열어 둔 채 새 탭을 만들려면 파일 → <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE426;</span>새 프로젝트 탭 또는 <kbd>N</kbd>을 사용합니다. 프로젝트 세부 정보의 탭 메뉴와 이전·다음 버튼으로 전환합니다.</p>
                    <h3>저장과 자동저장</h3>
                    <p>파일 → 다른 이름으로 저장 또는 <kbd>Ctrl + Shift + S</kbd>로 새 파일 이름이나 위치를 선택합니다. 저장한 뒤에는 <kbd>Ctrl + S</kbd>도 새 파일에 저장합니다.</p>
                    <p>파일 → <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE14D;</span>저장 또는 <kbd>Ctrl + S</kbd>로 프로젝트를 저장합니다. 설정에서 자동저장을 켜고 시간 간격과 보관할 파일 수를 지정할 수 있습니다. 보관 수를 넘긴 자동저장 파일은 제거됩니다.</p>
                    <p>자동저장으로 복구하려면 설정 → 자동저장 → 파일위치 열기로 폴더를 확인하고 필요한 파일을 프로젝트로 엽니다.</p>
                    <h3>소환 설정</h3>
                    <p>프로젝트 세부 정보에서 부모 엔티티, 소환좌표와 NBT를 설정합니다. 상단 소환, 파일 → <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE0B2;</span>내보내기 또는 <kbd>E</kbd>로 소환 명령어 창을 엽니다.</p>
                    <h3>내보내기 형식</h3>
                    <ul>
                        <li><strong>Command:</strong> 커맨드 블록에서 사용할 명령어를 생성합니다.</li>
                        <li><strong>DataPack:</strong> 함수 파일용 명령어를 생성합니다. <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE14D;</span>mcfunction 저장 버튼으로 파일을 저장할 수 있습니다.</li>
                        <li><strong>Separate:</strong> 오브젝트별로 개별 소환 명령어를 생성합니다.</li>
                    </ul>
                    <p>생성된 명령어는 복사 버튼으로 가져갑니다. 길이 제한이나 생성 실패 메시지가 있으면 내보내기 형식과 프로젝트 내용을 확인합니다.</p>`
            }
        ]
    },
    {
        id: 'advanced', title: '고급 조작',
        pages: [
            {
                id: 'modeling', title: '정밀 변환과 모델링',
                content: `
                    <p>기본 이동·회전·크기 조절을 익혔다면 좌표계와 피벗으로 조작 기준을 정하고, 버텍스·나이프·기울이기·스케일 모드와 대칭 기능으로 복잡한 형태를 만듭니다.</p>
                    <h3>로컬·월드 좌표계</h3>
                    <p><kbd>X</kbd>로 좌표계를 전환합니다. <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE0E8;</span>월드는 장면의 고정된 축을, <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE2FE;</span>로컬은 선택한 대상의 방향을 기준으로 조작합니다. 회전된 물체를 그 물체의 방향으로 옮기려면 로컬을 사용합니다.</p>
                    <h3>피벗</h3>
                    <p>피벗은 회전과 크기 조절의 기준점입니다. <kbd>Z</kbd>로 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE29E;</span>중심·<span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE0AC;</span>원점을 전환합니다. <kbd>Alt</kbd>를 누른 채 이동 도구를 조작하면 피벗을 편집하고, <kbd>Ctrl + Alt</kbd>로 초기화합니다.</p>
                    <h3>드래그 간격과 미세 조정</h3>
                    <p>설정에서 위치·각도·스케일 드래그값을 지정하면 일정한 간격으로 조작합니다. <kbd>Shift</kbd>를 누르면 미세조정 위치·각도·스케일 드래그값을 적용합니다. 미세조정의 기본값은 제한없음입니다. 드래그 정렬을 켜면 위치·스케일이 시작값 기준이 아니라 드래그값의 배수로 정렬됩니다.</p>
                    <h3><span class="user-guide-icon lucide-icon vertex-icon" aria-hidden="true">&#xE121;</span>버텍스 모드</h3>
                    <p><kbd>V</kbd>로 버텍스 모드를 켭니다. 꼭짓점을 선택하고 이동·회전·크기 도구로 형태를 조절합니다. 작업을 마치면 <kbd>V</kbd>를 다시 눌러 일반 오브젝트 편집으로 돌아갑니다.</p>
                    <h3>나이프</h3>
                    <p>나눌 대상을 선택한 뒤 <kbd>K</kbd>로 나이프 기능을 실행합니다. 작업 후 씬 목록에서 나뉜 오브젝트를 확인하고 필요한 부분을 선택해 편집합니다.</p>
                    <h3><span class="user-guide-icon transform-icon shear" aria-hidden="true"></span>기울이기와 제거</h3>
                    <p><kbd>W</kbd>로 기울이기(shear) 도구를 선택하고 손잡이를 드래그합니다. <kbd>Q</kbd>는 선택한 대상의 기울어짐을 제거합니다. 회전된 상태에서 크기를 바꾸다가 형태가 예상과 달라졌을 때도 확인할 기능입니다.</p>
                    <h3><span class="user-guide-icon transform-icon blockbench-scale" aria-hidden="true"></span>블록벤치 스케일</h3>
                    <p><kbd>B</kbd>로 블록벤치 스케일 모드를 전환합니다. 크기 조절의 기준이 달라지므로 손잡이를 조금 움직여 고정되는 쪽과 늘어나는 방향을 확인한 뒤 작업하세요.</p>
                    <h3><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE357;</span>스마트 스케일</h3>
                    <p><kbd>J</kbd>로 스마트 스케일을 켜고 크기 도구를 조작합니다. 확장 과정에서 오브젝트를 복제해 이어 붙이는 작업에 사용합니다. 일반적인 크기 조절로 돌아가려면 다시 끕니다.</p>
                    <h3>반전과 대칭 편집</h3>
                    <p>3D 화면의 오른쪽 클릭 메뉴에서 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE417;</span>좌우반전의 X·Y·Z축 반전을 선택합니다. 같은 메뉴의 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE3B6;</span>미러링 모델링을 켜면 연결된 대칭 대상과 함께 편집할 수 있습니다. 반전할 대상과 기준 위치를 확인한 뒤 실행하세요.</p>`
            },
            {
                id: 'heads', title: '헤드 페인팅과 텍스처 편집',
                content: `
                    <p>헤드 페인터는 3D 헤드 표면과 헤드 텍스처 아틀라스에 직접 그림을 그리는 기능입니다. 브러시·양동이·지우개·색상 선택·스탬프·선택의 여섯 도구를 사용하며, 모델 생성과 Minecraft용 텍스처 생성도 같은 패널에서 진행합니다.</p>
                    <h3>시작과 기본 작업 순서</h3>
                    <ol>
                        <li>편집할 헤드를 추가하거나 아래의 모델 생성으로 플레이어·머리·이미지 모델을 만듭니다.</li>
                        <li>오브젝트 도구의 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE1D3;</span>헤드 페인터 버튼을 눌러 패널을 엽니다. 페인터를 켜면 기존 오브젝트 선택이 해제됩니다.</li>
                        <li>레이어와 그리드, 도구, 색상과 알파를 정한 뒤 3D 표면 또는 아틀라스에서 왼쪽 버튼으로 클릭하거나 드래그합니다. 마우스를 올리면 적용 범위를 미리 확인할 수 있습니다.</li>
                        <li>편집 결과를 프로젝트로 저장합니다. Minecraft용 텍스처가 필요하면 텍스쳐 생성까지 마친 뒤 소환 명령어를 내보냅니다.</li>
                    </ol>
                    <p>헤드 페인터 버튼을 다시 누르면 페인팅을 종료합니다. 편집 도중 모델의 위치나 크기를 바꾸려면 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE121;</span>선택 도구를 사용합니다.</p>

                    <h3>레이어와 그리드</h3>
                    <ul>
                        <li><strong>2번 레이어 — 기본:</strong> 3D에서 마우스 위치의 겉 레이어 픽셀이 보이면 겉 레이어를, 투명하면 기본 레이어를 편집합니다.</li>
                        <li><strong>2번 레이어 — 켜기:</strong> 겉 레이어를 편집합니다. 투명한 위치에 새 겉 레이어 픽셀을 칠할 때 사용합니다.</li>
                        <li><strong>2번 레이어 — 끄기:</strong> 겉 레이어를 숨기고 기본 레이어를 편집합니다.</li>
                        <li><strong>가로·세로:</strong> 각 방향의 그리드 수를 0~8로 지정합니다. 작은 수를 쓰면 한 번에 더 큰 칸을 칠합니다. 0인 방향은 그리드 선을 표시하지 않습니다.</li>
                        <li><strong>그리드:</strong> 격자 표시를 켜거나 끄고, 그리드 색상 버튼이나 색상 코드로 선의 색을 바꿉니다. 그리드를 숨겨도 설정한 칸 단위로 칠합니다.</li>
                        <li><strong>스마트 그리드:</strong> 모델 면의 가로·세로 비율에 맞춰 칸 수를 자동 조정합니다.</li>
                        <li><strong>헤드별 그리드:</strong> 선택 도구로 헤드를 고른 뒤 속성의 그리드 가로·그리드 세로를 바꾸면 해당 헤드의 값을 따로 지정합니다. 이 값이 있으면 공통 스마트 그리드보다 우선합니다.</li>
                    </ul>
                    <p>아틀라스에서는 실제 이미지의 기본·겉 레이어 영역을 직접 고릅니다. 기본 레이어는 불투명하게 유지되고, 겉 레이어는 알파를 사용할 수 있습니다.</p>

                    <h3><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE1D3;</span>브러시와 픽셀 덮어쓰기</h3>
                    <p>모양을 사각형 또는 원형으로 정하고 가로·세로 크기를 각각 설정합니다. 강도는 0~100%, 간격은 1~100%입니다. 간격을 줄이면 드래그할 때 도장이 촘촘하게 찍힙니다. 커스텀 브러시를 선택하면 저장된 픽셀 모양과 색상, 강도·간격을 사용합니다.</p>
                    <p>픽셀 덮어쓰기를 끄면 기존 색과 새 색을 알파·강도에 따라 겹쳐 칠합니다. 켜면 완전히 적용되는 브러시 픽셀을 새 RGBA 값으로 교체합니다. 강도가 낮거나 가장자리가 약하게 적용되는 픽셀은 혼합되며, 기본 레이어의 알파는 불투명하게 유지됩니다.</p>

                    <h3>커스텀 브러시 만들기와 편집</h3>
                    <ol>
                        <li>+ 커스텀 브러시를 누르거나 기존 브러시의 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE2F0;</span>설정 버튼을 누릅니다.</li>
                        <li>이름, 가로·세로, 색상, 알파, 강도와 간격을 지정합니다. 크기를 줄이면 범위 밖의 픽셀은 잘립니다.</li>
                        <li>픽셀을 클릭해 선택하고 왼쪽 버튼으로 드래그해 칠합니다. 오른쪽 버튼으로 드래그하면 픽셀을 지웁니다.</li>
                        <li><kbd>Ctrl</kbd>을 누른 채 드래그하면 사각 영역을 선택합니다. 선택 후에는 그 영역 안에서 편집하며, <kbd>Delete</kbd> 또는 <kbd>Backspace</kbd>로 선택한 픽셀을 지웁니다. <kbd>Ctrl + G</kbd>로 선택을 해제합니다.</li>
                        <li>픽셀 편집에 초점이 있을 때 <kbd>Ctrl + Z</kbd>로 실행 취소하고, <kbd>Ctrl + Shift + Z</kbd> 또는 <kbd>Ctrl + Y</kbd>로 다시 실행합니다. 저장으로 확정하고 나가기로 저장하지 않은 편집을 닫습니다.</li>
                    </ol>
                    <p>브러시 목록의 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE1D3;</span>브러시 선택 버튼으로 사용하고, <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE18E;</span>삭제 버튼으로 제거합니다. 목록을 드래그해 순서를 바꿀 수 있으며 커스텀 브러시는 다음 작업에서도 재사용할 수 있습니다.</p>

                    <h3><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE28F;</span>지우개</h3>
                    <p>크기 1~8, 경도 0~100%, 강도 0~100%를 조절한 뒤 드래그합니다. 경도를 낮추면 가장자리의 적용이 부드러워지고, 강도를 낮추면 조금씩 지웁니다. 겉 레이어에서는 알파를 줄여 투명하게 지우며, 기본 레이어에서는 검정으로 지웁니다.</p>

                    <h3><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE13B;</span>색상 선택과 알파</h3>
                    <p>색상 선택 도구로 3D 모델의 텍스처 또는 아틀라스의 픽셀을 클릭하면 색상과 알파를 가져와 현재 팔레트 칸에 저장합니다. 헤드 외의 텍스처가 있는 모델에서도 색을 가져올 수 있습니다.</p>
                    <p>팔레트의 색상 사각형을 누르면 색상 선택 창이 열립니다. 색상 영역·색조 슬라이더, RGB 또는 OKLCH 채널, HEX 값으로 색을 고르고 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE13B;</span>색 스포이드로 화면의 색을 가져옵니다. 디스플레이 엔티티를 누르면 조명이 적용되기 전의 원래 색을, 그 밖의 곳(PDE 창 밖 포함)을 누르면 보이는 화면 색을 가져옵니다. 창의 제목을 드래그해 옮기고 가장자리·모서리로 크기를 조절할 수 있습니다.</p>
                    <p>팔레트의 일반 모드는 6자리 HEX, OKLCH 모드는 <code>oklch(0.7 0.15 30)</code> 같은 값으로 입력합니다. <kbd>Enter</kbd>로 적용할 수 있습니다. 알파는 0~255이며 0은 투명, 255는 불투명입니다. 반투명·투명 페인팅은 겉 레이어에서 사용합니다.</p>

                    <h3><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE2E6;</span>양동이 채우기</h3>
                    <table><thead><tr><th>조작</th><th>3D 표면</th><th>아틀라스</th></tr></thead><tbody>
                        <tr><td>일반 클릭</td><td>클릭한 칸에서 이어진 같은 RGB 칸을 채웁니다. 모서리로 이어진 다른 면까지 퍼집니다.</td><td>클릭한 픽셀에서 이어진 같은 RGB 영역을 채웁니다. UV 밖에서는 알파도 같은 영역을 찾습니다.</td></tr>
                        <tr><td><kbd>Shift</kbd> + 클릭</td><td>현재 면에서 클릭한 픽셀과 RGB가 같은 칸을 모두 채웁니다.</td><td>클릭한 UV 면에서 RGB가 같은 픽셀을 모두 채웁니다.</td></tr>
                        <tr><td><kbd>Ctrl</kbd> + 클릭</td><td>클릭한 면 전체를 채웁니다.</td><td>클릭한 UV 면 전체를 채웁니다.</td></tr>
                        <tr><td><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + 클릭</td><td>해당 헤드의 현재 레이어 여섯 면 전체를 채웁니다.</td><td>클릭한 UV에 해당하는 헤드의 현재 레이어 여섯 면을 채웁니다.</td></tr>
                    </tbody></table>
                    <p>아틀라스의 페인팅 선택 범위가 있으면 그 안에서만 채웁니다. 기본 레이어는 불투명하게 채워집니다.</p>

                    <h3><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE3BB;</span>스탬프 복사와 배치</h3>
                    <p>먼저 가로·세로 크기를 정한 뒤 <kbd>Shift</kbd>를 누른 채 복사할 위치를 클릭합니다. 패널의 미리보기에서 복사된 모양을 확인하고, 적용할 위치를 클릭하거나 드래그해 배치합니다. <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE148;</span>왼쪽 회전·<span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE149;</span>오른쪽 회전은 90도씩 회전하고, <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE35D;</span>좌우 반전·<span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE35E;</span>상하 반전으로 뒤집습니다. <kbd>Ctrl</kbd>을 누른 채 클릭하면 스탬프 크기 단위 격자에 맞춰 정렬 배치되어, 이어서 클릭해도 빈틈이나 겹침 없이 타일처럼 깔립니다.</p>
                    <p>스탬프는 복사한 픽셀의 색상과 알파를 배치합니다. 크기 변경은 복사 영역의 크기를 바꾸는 방식이므로 원하는 크기로 정한 뒤 다시 복사하세요.</p>

                    <h3>인접 헤드 페인트와 대칭 페인팅</h3>
                    <p>인접 헤드 페인트를 켜면 3D에서 브러시·스탬프가 닿는 주변 헤드에도 이어 칠할 수 있고, 양동이의 일반 클릭·<kbd>Shift</kbd>·<kbd>Ctrl</kbd> 채우기도 연결된 인접 헤드로 확장됩니다. <kbd>Ctrl</kbd>+<kbd>Shift</kbd>의 여섯 면 채우기는 클릭한 헤드가 대상입니다. 끄면 다른 헤드로 넘어가는 페인팅을 제한합니다.</p>
                    <p>3D 화면의 오른쪽 클릭 메뉴에서 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE3B6;</span>미러링 모델링을 켜고 연결된 대칭 헤드를 편집하면 3D에서 칠한 텍스처도 X축으로 반전해 함께 반영됩니다. 아틀라스 직접 편집은 해당 이미지 영역을 편집하는 방식입니다.</p>

                    <h3>팔레트와 그라데이션</h3>
                    <ul>
                        <li><strong>64개 색상 칸:</strong> 클릭해 사용할 색을 고릅니다. 빈 칸을 선택한 뒤 색상이나 알파를 입력하면 그 칸에 저장합니다. 칸을 오른쪽 클릭하면 현재 색을 저장합니다.</li>
                        <li><strong>색 지우기:</strong> 칸에 초점을 둔 채 <kbd>Delete</kbd> 또는 <kbd>Backspace</kbd>를 누르면 해당 색만 지웁니다. 팔레트의 지우기는 64개 칸을 모두 비웁니다.</li>
                        <li><strong>색 정렬:</strong> 채워진 칸을 RGBA 값 순으로 정렬하고 빈 칸을 뒤로 보냅니다.</li>
                        <li><strong>그라데이션:</strong> 시작·끝 칸에 색을 넣고 <kbd>Shift</kbd>를 누른 채 두 칸을 차례로 클릭합니다. 사이의 칸을 OKLCH 색상과 알파를 보간한 색으로 채웁니다.</li>
                    </ul>

                    <h3>팔레트 목록과 프리셋</h3>
                    <p>팔레트 목록에서 기본 팔레트 또는 저장한 커스텀 팔레트의 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE1DD;</span>팔레트 사용 버튼을 누릅니다. + 커스텀 팔레트 추가로 현재 팔레트에 이름을 붙여 저장하고, 이름 입력 후 <kbd>Enter</kbd>로 확정합니다. <kbd>Escape</kbd>로 이름 입력을 취소합니다.</p>
                    <p>커스텀 팔레트는 이름 변경·<span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE18E;</span>삭제·드래그 순서 변경을 지원합니다. 커스텀 팔레트를 사용하는 중 바꾼 색은 해당 프리셋에도 저장됩니다. 기본 팔레트는 삭제할 수 없습니다.</p>

                    <h3><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE121;</span>선택 도구와 모델 편집</h3>
                    <p>선택 도구에서는 페인트를 칠하지 않고 일반 오브젝트 선택·이동·회전·크기 조절을 사용합니다. 헤드를 선택해 속성의 텍스쳐와 그리드 가로·세로도 편집할 수 있습니다. 모델을 조절한 뒤 브러시 등 페인팅 도구로 돌아갑니다. 아틀라스의 UV·텍스처 영역을 옮기거나 복제할 때도 먼저 선택 도구로 바꿉니다.</p>

                    <h3>아틀라스 보기와 페인팅 범위 선택</h3>
                    <p>헤드 텍스처 아틀라스 패널에서 휠로 마우스 위치를 기준으로 확대·축소하고, 오른쪽 버튼으로 드래그해 화면을 이동합니다. 여러 아틀라스가 있으면 아래 썸네일로 전환하며 각 이미지의 해상도를 확인합니다.</p>
                    <p>페인팅 도구를 사용하는 중 <kbd>Ctrl</kbd>을 누른 채 아틀라스를 드래그하면 사각 페인팅 범위를 정합니다. 브러시·지우개·양동이·스탬프는 이 범위 안에만 적용됩니다. 범위 밖을 일반 클릭하거나 <kbd>Escape</kbd>를 누르면 범위를 해제합니다. <kbd>Ctrl</kbd> 클릭과 드래그는 구분되므로 여섯 면 채우기는 드래그하지 말고 클릭하세요.</p>

                    <h3>UV와 텍스처 영역 편집</h3>
                    <p>UV는 모델의 면이 참조하는 이미지 영역입니다. 페인터의 선택 도구 또는 페인팅을 종료한 상태에서 다음 모드 중 하나를 고릅니다.</p>
                    <table><thead><tr><th>모드</th><th>동작</th></tr></thead><tbody>
                        <tr><td><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE1CB;</span>UV만 이동</td><td>이미지는 두고 모델의 참조 영역을 옮깁니다. 다른 이미지 영역을 보게 하거나 UV 크기를 조절할 때 사용합니다.</td></tr>
                        <tr><td><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE0F6;</span>텍스처만 이동</td><td>UV는 두고 이미지 픽셀을 옮깁니다.</td></tr>
                        <tr><td><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE529;</span>UV와 텍스처 함께 이동</td><td>참조 영역과 이미지 픽셀을 함께 옮깁니다.</td></tr>
                    </tbody></table>
                    <ul>
                        <li><strong>영역 선택:</strong> 클릭으로 고르고 <kbd>Shift</kbd> 클릭으로 추가·해제합니다. <kbd>Ctrl</kbd> 드래그로 영역을 선택하며 <kbd>Ctrl + Shift</kbd> 드래그는 기존 선택에 추가합니다. 아틀라스에 초점을 두고 <kbd>Ctrl + A</kbd>로 현재 모드의 전체 영역을 선택합니다.</li>
                        <li><strong>이동과 크기:</strong> 선택 영역을 드래그하거나 선택에 초점을 둔 채 방향키로 1픽셀씩 옮깁니다. UV만 이동에서 한 영역을 선택하면 가장자리·모서리 손잡이로 크기를 조절할 수 있고, <kbd>Shift</kbd> + 방향키로 오른쪽·아래쪽 크기를 조절합니다.</li>
                        <li><strong>복제:</strong> <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE09E;</span>선택 영역 복제 또는 <kbd>D</kbd>로 빈 공간에 복사합니다. UV 관련 모드에서는 참조 위치도 복사된 곳으로 옮기며, 텍스처만 이동 모드에서는 픽셀만 복사합니다. 오브젝트 수는 늘어나지 않습니다.</li>
                        <li><strong>삭제와 반전:</strong> <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE18E;</span>삭제 또는 <kbd>Delete</kbd>, <kbd>Backspace</kbd>는 선택 영역의 텍스처를 지웁니다. <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE35D;</span>좌우 반전·<span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE35E;</span>상하 반전은 픽셀을 뒤집습니다. 오브젝트 삭제와 구분하세요.</li>
                        <li><strong>확인과 취소:</strong> 아래 X·Y·픽셀 크기로 위치와 크기를 확인합니다. 드래그 도중 <kbd>Escape</kbd>는 변경을 취소하고, 드래그하지 않을 때는 선택을 해제합니다. 이동 모드를 바꾸면 기존 영역 선택도 해제됩니다.</li>
                    </ul>

                    <h3><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE1DD;</span>아틀라스 색상 교체</h3>
                    <p>원본 색상과 변경할 색상을 6자리 HEX 또는 색상 버튼으로 지정하고 허용오차%를 정한 뒤 바꾸기를 누릅니다. 0%는 같은 RGB만, 더 큰 값은 비슷한 색도 바꿉니다. 비슷한 색의 명암 차이는 유지하며 알파는 바꾸지 않습니다.</p>
                    <p>페인팅 범위나 UV·텍스처 영역을 선택했다면 그 범위만 바꾸고, 선택이 없으면 현재 아틀라스 전체를 바꿉니다. 여러 선택 영역은 합친 범위를 사용하며 다른 아틀라스에는 적용하지 않습니다.</p>

                    <h3>플레이어·머리 모델 생성</h3>
                    <ol>
                        <li>모델 생성에서 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE19F;</span>플레이어 또는 <span class="user-guide-icon user-guide-head-icon" aria-hidden="true"></span>머리를 고릅니다.</li>
                        <li>플레이어는 기본 또는 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE1A2;</span>애니메이션 형식을 선택하고 팔이 가는 스킨이면 슬림을 켭니다.</li>
                        <li><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE091;</span>텍스쳐 기반 불러오기로 64×64 PNG 스킨을 선택하거나, 영문·숫자·밑줄 3~16자의 닉네임을 입력해 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE19E;</span>닉네임으로 불러오기를 누릅니다.</li>
                        <li>생성 상태를 확인합니다. 결과는 현재 프로젝트에 추가되며, 스킨 조회에 대체 이미지가 사용되면 생성 완료 메시지에 표시됩니다.</li>
                    </ol>

                    <h3><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE0F6;</span>이미지 모델 생성</h3>
                    <p>모델 생성에서 이미지를 고른 뒤 1번 레이어 또는 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE5C4;</span>2번 레이어 버튼으로 PNG를 엽니다. 이미지를 8×8픽셀 타일로 나눈 헤드들이 하나의 그룹으로 현재 프로젝트에 추가됩니다. 1번 레이어는 검정 배경으로 불투명하게, 2번 레이어는 투명도를 유지하는 방식으로 만듭니다. 스킨과 달리 이미지 모델용 PNG는 64×64로 제한되지 않습니다.</p>

                    <h3>텍스처 생성용 계정과 MineSkin 키</h3>
                    <p>설정 → 일반 설정 → 헤드 페인트 계정에서 생성에 사용할 계정을 준비합니다.</p>
                    <ul>
                        <li><strong>Minecraft:</strong> 로그인하기를 누르고 브라우저에서 Microsoft 로그인을 마칩니다. 여러 계정을 추가하고 각 계정의 체크박스로 생성 참여 여부를 정합니다. 로그인 중에는 로그인 취소로 중단하고, <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE18E;</span>계정 삭제로 목록에서 제거합니다.</li>
                        <li><strong>MineSkin:</strong> ＋로 API 키 입력란을 추가하고 키를 입력합니다. 키 수정·<span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE0BA;</span>표시·<span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE0BB;</span>숨기기·<span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE18E;</span>삭제를 사용할 수 있습니다.</li>
                    </ul>

                    <h3>텍스처 생성·취소·스킨 복원</h3>
                    <p>헤드 페인터의 텍스쳐 생성을 누르면 현재 프로젝트에서 PNG 상태인 헤드 텍스처를 Minecraft용 텍스처로 변환합니다. 현재 프로젝트 전체의 PNG 헤드가 대상이므로 생성 전에 편집한 헤드를 확인하세요.</p>
                    <p>진행 표시에서 생성·적용, 완료 수와 실패 수, 자동 재시도 예정 시각을 확인합니다. 생성 중에는 진행 창이 편집 입력을 막으며 취소 버튼으로 중단을 요청할 수 있습니다. 실패한 항목은 기존 텍스처를 유지합니다.</p>
                    <p>Minecraft 계정을 사용한 경우 원래 스킨 복원이 끝났는지 완료 상태를 확인합니다. 취소 후에도 복원이 필요할 수 있으며, 원래 스킨 복원 확인 필요가 표시되면 복원 재시도를 실행합니다. 다른 프로젝트에서 받은 생성 결과가 남아 있으면 해당 프로젝트로 돌아가 반영한 뒤 다음 생성을 진행합니다.</p>

                    <h3>실행 취소·저장과 패널 정리</h3>
                    <p>페인팅, 아틀라스 편집, 모델 생성과 텍스처 적용은 프로젝트의 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE19B;</span>실행 취소·<span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE143;</span>다시 실행으로 되돌릴 수 있습니다. <kbd>Ctrl + Z</kbd>, <kbd>Ctrl + Shift + Z</kbd> 또는 <kbd>Ctrl + Y</kbd>를 사용합니다. 커스텀 브러시 편집 창의 픽셀 기록은 그 창 안에서 따로 다룹니다.</p>
                    <p><kbd>Ctrl + S</kbd>로 프로젝트를 저장해 편집을 이어가고, Minecraft에서 사용할 때는 텍스처 생성 상태를 확인한 뒤 소환 명령어를 내보냅니다. 커스텀 브러시·팔레트 저장은 프로젝트 저장과 별도로 관리됩니다.</p>
                    <p>레이어와 그리드·도구 설정·팔레트·모델 생성·텍스쳐 생성의 제목을 드래그해 패널 안의 순서를 바꿀 수 있습니다. 배치 순서는 유지되며, 순서를 바꾸는 중 <kbd>Escape</kbd>로 취소합니다. 헤드 페인터와 아틀라스 패널 전체의 이동·탭 묶기·크기 변경은 기본 조작의 패널 조작에서 설명합니다.</p>`
            },
            {
                id: 'settings', title: '설정과 단축키',
                content: `
                    <p>오브젝트 도구의 <span class="user-guide-icon user-guide-menu-icon" aria-hidden="true">≡</span>설정 버튼 또는 <kbd>Tab</kbd>으로 설정을 엽니다. 이 사용설명서에 적힌 단축키는 기본 설정 기준이며, 변경한 키는 설정 → <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE284;</span>단축키에서 확인합니다.</p>
                    <h3>화면과 조작 설정</h3>
                    <p><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE30B;</span>일반 설정에서 카메라 종류와 FOV, 렌더 해상도, 격자·XYZ축 표시와 높이를 조절합니다. 도구 패널의 위치와 변환 도구 배치, 스케일 조작 모드, 오브젝트 교체 모드, 드래그 간격도 설정할 수 있습니다.</p>
                    <h3>단축키 변경</h3>
                    <p><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE284;</span>단축키 페이지에서 바꿀 동작의 키 입력을 선택하고 원하는 키 조합을 지정합니다. 충돌 표시가 나타나면 같은 키를 사용하는 다른 동작을 확인합니다. 기본값으로 되돌리거나 프리셋을 저장·불러올 수 있습니다.</p>
                    <h3>자주 쓰는 기본 단축키</h3>
                    <table><thead><tr><th>동작</th><th>기본 키</th></tr></thead><tbody>
                        <tr><td><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE121;</span>이동 / <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE149;</span>회전 / <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE2EC;</span>크기</td><td><kbd>T</kbd> / <kbd>R</kbd> / <kbd>S</kbd></td></tr>
                        <tr><td>좌표계 / 피벗 전환</td><td><kbd>X</kbd> / <kbd>Z</kbd></td></tr>
                        <tr><td>선택 항목에 초점</td><td><kbd>F</kbd></td></tr>
                        <tr><td>그룹 생성·해제 / 그룹 해제</td><td><kbd>G</kbd> / <kbd>Ctrl + G</kbd></td></tr>
                        <tr><td><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE09E;</span>복제 / <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE18E;</span>삭제</td><td><kbd>D</kbd> / <kbd>Delete</kbd></td></tr>
                        <tr><td><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE19B;</span>실행 취소 / <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE143;</span>다시 실행</td><td><kbd>Ctrl + Z</kbd> / <kbd>Ctrl + Shift + Z</kbd></td></tr>
                        <tr><td><span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE247;</span>프로젝트 열기 / <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE14D;</span>저장</td><td><kbd>Ctrl + O</kbd> / <kbd>Ctrl + S</kbd></td></tr>
                        <tr><td>다른 이름으로 저장</td><td><kbd>Ctrl + Shift + S</kbd></td></tr>
                        <tr><td>소환 명령어 / 설정</td><td><kbd>E</kbd> / <kbd>Tab</kbd></td></tr>
                        <tr><td>씬 항목 이름 변경 / 셰이딩 전환</td><td><kbd>F2</kbd> / <kbd>L</kbd></td></tr>
                    </tbody></table>
                    <h3>씬 현황</h3>
                    <p>설정의 <span class="user-guide-icon lucide-icon" aria-hidden="true">&#xE06A;</span>씬 현황에서 메모리와 현재 프로젝트의 상태를 확인할 수 있습니다. 화면이 느려졌다면 렌더 해상도를 낮춰 비교하고, 필요 없는 오브젝트나 텍스처를 정리합니다.</p>`
            },
            {
                id: 'troubleshooting', title: '문제 해결',
                content: `
                    <p>문제가 생기면 선택 대상, 현재 도구와 모드, 속성 값을 먼저 확인합니다. 큰 수정을 하기 전에는 프로젝트를 저장해 두세요.</p>
                    <h3>오브젝트가 보이지 않을 때</h3>
                    <ol>
                        <li>씬 목록에서 대상과 상위 그룹의 표시 상태를 확인합니다.</li>
                        <li>대상을 선택하고 <kbd>F</kbd>로 카메라를 맞춥니다.</li>
                        <li>위치·크기, 텍스트나 텍스처의 투명도, 헤드 레이어 상태를 확인합니다.</li>
                    </ol>
                    <h3>조작 결과가 예상과 다를 때</h3>
                    <p>로컬·월드 좌표계, 피벗 위치, 버텍스 모드, 블록벤치 스케일, 스마트 스케일과 미러링 상태를 확인합니다. 조작이 일정 간격으로 움직이면 드래그값을 바꾸거나 <kbd>Shift</kbd>로 미세 조정합니다. 잘못된 변경은 <kbd>Ctrl + Z</kbd>로 되돌립니다.</p>
                    <h3>추가하려는데 기존 오브젝트가 바뀔 때</h3>
                    <p>오브젝트가 선택되어 있으면 도구에서 고른 항목으로 교체됩니다. 실행 취소한 뒤 빈 공간을 클릭해 선택을 해제하고 다시 추가하세요.</p>
                    <h3>텍스처 생성이 실패할 때</h3>
                    <p>계정 로그인 또는 MineSkin 키 상태와 진행 메시지를 확인합니다. 자동 재시도 대기 중이면 표시된 시간을 기다립니다. 원래 스킨 복원이 필요하다는 메시지가 있으면 복원 재시도를 실행하고 완료 상태를 확인합니다.</p>
                    <h3>소환·내보내기가 되지 않을 때</h3>
                    <p>소환 명령어 창의 오류 메시지와 글자 수, 선택한 내보내기 형식을 확인합니다. 부모 엔티티, 소환좌표, 직접 입력한 NBT와 헤드 텍스처 생성 상태도 확인하세요. 프로젝트 저장 파일과 Minecraft 실행용 명령어는 용도가 다릅니다.</p>
                    <h3>저장하지 않은 작업을 찾을 때</h3>
                    <p>자동저장을 켜 두었다면 설정에서 저장 폴더를 열고 최근 파일을 확인합니다. 필요한 파일을 열어 내용을 확인한 뒤 프로젝트로 저장하세요. 자동저장을 끄거나 보관 수를 넘겨 제거된 작업은 자동저장 폴더에 남아 있지 않을 수 있습니다.</p>`
            }
        ]
    }
];

export const userGuidePages = userGuideSections.flatMap(section => section.pages);
