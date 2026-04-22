# Setting Up the Development Environment

## Part 1: Setup VS Code on Windows and Github Repository for the Project

Now, let’s set up your development environment using VS Code with WSL (Ubuntu) in a folder named Vaipakam, and configure a GitHub repository for code maintenance.

### Step 1: Install WSL and Ubuntu

- **Enable WSL on Windows:**
  - Open PowerShell as Administrator and run:
    ```bash
    wsl --install
    ```
  - Restart your computer if prompted.

- **Install Ubuntu:**
  - Open the Microsoft Store, search for "Ubuntu," and install the latest version (e.g., Ubuntu 20.04 or 22.04).
  - Launch Ubuntu from the Start menu and follow the prompts to set up your username and password.

### Step 2: Install VS Code

- Download and Install VS Code:
  - Visit code.visualstudio.com and download the installer for Windows.
  - Run the installer and follow the instructions.
- Install the WSL Extension:
  - Open VS Code, go to the Extensions view (Ctrl+Shift+X), search for "WSL," and install the "Remote - WSL" extension by Microsoft.

### Step 3: Set Up the Project Folder

- **Open WSL in VS Code:**
  - Open VS Code, press ``Ctrl+` `` (backtick) to open the terminal, and select "WSL: Ubuntu" from the dropdown (or type `wsl` to switch to the Ubuntu terminal).
- **Create the Project Folder:**
  - In the WSL terminal, run:
    ```bash
    mkdir Vaipakam
    cd Vaipakam
    ```

### Step 4: Initialize Git and GitHub Repository

- Install Git:
  - In the WSL terminal, update the package list and install Git:
    ```bash
    sudo apt update
    sudo apt install git
    ```
- **Configure Git:**
  - Set your Git username and email (replace with your details):
    ```bash
        git config --global user.name "Your Name"
        git config --global user.email "your.email@example.com"
    ```

- **Create a GitHub Repository:**
  - Go to github.com, log in, and click "New Repository."
  - Name it "Vaipakam," keep it public or private as preferred, and create it (do not initialize with a README yet).

- **Initialize the Local Repository:**
  - In the WSL terminal (inside the Vaipakam folder):

    ```bash
    git init
    git remote add origin https://github.com/yourusername/Vaipakam.git
    ```

  - Replace yourusername with your GitHub username.

### Step 5: Create and Commit the Initial README.md

- Create the README.md File:
  - In the WSL terminal:

    ```bash
    touch README.md
    ```

  - Open README.md in VS Code by typing:
    ```bash
    code README.md
    ```
  - Copy and paste the clarifications from above into the file, adjusting sections as needed, and save it.

- **Commit and Push to GitHub:**
  - In the WSL terminal:
    ```bash
    git add README.md
    git commit -m "Add initial README with project clarifications"
    git push -u origin main
    ```

## Part 2: Setup Foundry, Nodejs and extensions for VS Code

### Step 1: Install Foundry

Foundry is a fast and efficient toolkit for Ethereum smart contract development (compiling, testing, deploying). Here’s how to install it in WSL Ubuntu:

- **Install Dependencies**
  Ensure curl and git are installed:

```bash
sudo apt update
sudo apt install curl git -y
```

- **Install Foundry**
  Run this command to download and install Foundry:

```bash
curl -L https://foundry.paradigm.xyz | bash
```

Follow any prompts to complete the installation (it’ll install forge, cast, and anvil).

- **Update Your PATH**
  Add Foundry to your PATH for easy access:

```bash
export PATH="$HOME/.foundry/bin:$PATH"
```

To make this permanent, add the line above to your ~/.bashrc file:

```bash
echo 'export PATH="$HOME/.foundry/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
foundryup
```

- **Verify Installation**
  Check that Foundry is working:

```bash
forge --version
cast --version
anvil --version
```

You should see version numbers for each tool.

### Step 2: Install Node.js and Yarn

For the React frontend, you’ll need Node.js and Yarn:

- **Install Node.js (v16 or later)**
  Install Node.js via the NodeSource repository:

```bash
curl -fsSL https://deb.nodesource.com/setup_16.x | sudo -E bash -
sudo apt install -y nodejs
```

- **Install Yarn**
  Install Yarn globally using npm:

```bash
npm install -g yarn
```

- **Verify Installation**
  Confirm the versions:

```bash
node --version # Should show v16.x.x or higher
yarn --version # Should show a version like 1.x.x
```

### Step 3: Install VS Code Extensions

Enhance your VS Code experience with these extensions (open VS Code, press Ctrl+Shift+X to access the Extensions view):

- **Solidity**
  - Search for “Solidity” and install the one by Juan Blanco for smart contract syntax highlighting and support.

- **ESLint**
  - Search for “ESLint” and install the one by Dirk Baeumer for JavaScript/TypeScript linting.

- **Prettier**
  - Search for “Prettier - Code formatter” and install it for consistent code formatting.

- **GitLens**
  - Search for “GitLens” and install it for advanced Git integration.

- **Remote - WSL**
  - Likely already installed, but ensure it’s enabled for smooth WSL integration.

### Step 4: Set Up the Project Structure

In your Vaipakam folder, create a basic structure:

```bash
mkdir contracts frontend tests scripts docs
```

- `contracts/`: For Solidity smart contracts.
- `frontend/`: For the React frontend.
- `tests/`: For Foundry test files.
- `scripts/`: For deployment and utility scripts.

### Step 5: Initialize Foundry Project

Start with smart contract development:

- **Navigate to the contracts folder:**

```bash
cd contracts
```

- **Initialize Foundry:**

```bash
forge init
```

This creates a sample contract and test setup.

- **Install OpenZeppelin Contracts**
  Since Vaipakam uses OpenZeppelin and chainlink libraries, install them:

```bash
~forge install OpenZeppelin/openzeppelin-contracts --no-commit~
~forge install smartcontractkit/chainlink-evm --no-commit~
forge install OpenZeppelin/openzeppelin-contracts-upgradeable --no-commit
forge install Uniswap/v3-core --no-commit
forge install smartcontractkit/chainlink-brownie-contracts --no-commit
forge install mudgen/diamond-3-hardhat --no-commit
```

### Step 6: Set Up the Frontend

Set up a basic React app:

- **Navigate to the frontend folder:**

```bash
cd ../frontend
```

- **Create a React App:**

```bash
npx create-react-app .
# npm install ethers
```

- **Install yarn**
  Add Ethers.js for blockchain interaction:

```bash
sudo apt install cmdtest
npm install -g yarn
```

- add below line in .bashrc

```bash
export PATH="$PATH:/home/yourusername/.nvm/versions/node/v22.14.0/bin/yarn"
```

- refresh bashrc

```bash
source ~/.bashrc
```

- **Install Ethers.js**
  Add Ethers.js for blockchain interaction:

```bash
yarn add ethers
```

- **Start the Development Server:**

```bash
yarn start
```

This opens a browser window with the React app running.
