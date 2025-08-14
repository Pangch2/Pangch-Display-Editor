/*
 * UI 열기/닫기 애니메이션 사용법:
 *
 * 이 스크립트는 UI 엘리먼트에 대한 재사용 가능한 열기 및 닫기 애니메이션 함수를 제공합니다.
 *
 * 1. 모듈 임포트:
 *    import { openWithAnimation, closeWithAnimation } from './ui-open-close.js';
 *
 * 2. 열기 애니메이션 적용:
 *    const myElement = document.getElementById('my-element');
 *    openWithAnimation(myElement);
 *
 * 3. 닫기 애니메이션 적용:
 *    // closeWithAnimation은 Promise를 반환하므로, 애니메이션이 끝난 후 DOM 제거 등의 후속 작업을 .then()으로 처리할 수 있습니다.
 *    closeWithAnimation(myElement).then(() => {
 *        myElement.remove();
 *    });
 */

// 애니메이션 스타일을 한 번만 추가하기 위한 플래그
let stylesAdded = false;

function addAnimationStyles() {
    if (stylesAdded) return;

    const styleSheet = document.createElement("style");
    styleSheet.innerText = `
        @keyframes uiOpen {
            from {
                transform: scale(0.8);
                opacity: 0.8;
            }
            to {
                transform: scale(1);
                opacity: 1;
            }
        }
        @keyframes uiClose {
            from {
                transform: scale(1);
                opacity: 1;
            }
            to {
                transform: scale(0.8);
                opacity: 0.0;
            }
        }
    `;
    document.head.appendChild(styleSheet);
    stylesAdded = true;
}

/**
 * 엘리먼트를 열기 애니메이션과 함께 표시합니다.
 * @param {HTMLElement} element - 애니메이션을 적용할 DOM 엘리먼트
 */
export function openWithAnimation(element) {
    addAnimationStyles(); // 필요 시 스타일 추가
    element.style.animation = 'uiOpen 0.15s ease-out forwards';
}

/**
 * 엘리먼트를 닫기 애니메이션과 함께 숨깁니다.
 * 애니메이션이 완료되면 resolve되는 Promise를 반환합니다.
 * @param {HTMLElement} element - 애니메이션을 적용할 DOM 엘리먼트
 * @returns {Promise<void>}
 */
export function closeWithAnimation(element) {
    return new Promise((resolve) => {
        element.style.animation = 'uiClose 0.15s ease-in forwards';
        setTimeout(() => {
            resolve();
        }, 300); // 애니메이션 시간과 동일하게 설정
    });
}
