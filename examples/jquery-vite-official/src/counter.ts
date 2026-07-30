import $ from 'jquery'

export function setupCounter(element: HTMLButtonElement) {
  let counter = 0
  const setCounter = (count: number) => {
    counter = count
    $(element).html(`Count is ${counter}`)
  }
  $(element).on('click', () => setCounter(counter + 1))
  setCounter(0)
}
